import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  AhorramasHttpError,
  AhorramasParseError,
  AhorramasProvider,
  normaliseAhorramasBasket,
  parseAhorramasCartHtml,
  parseAhorramasPrice,
  parseSearchPage,
  parseUnitPrice,
} from '../src/providers/ahorramas';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const basketLine = {
  UUID: 'line-uuid-1',
  id: '70865',
  productName: 'Leche Alipende',
  quantity: 2,
  unitPrice: { list: { value: '1,80' }, sales: { value: '1,49' } },
  priceTotal: { decimalPrice: '2,98' },
};

const emptyBasket = { items: [], quantityTotal: 0, totals: { total: '0,00' } };
const fullBasket = { items: [basketLine], quantityTotal: 2, totals: { total: '2,98' } };

function fakeBasketProvider(initial: any = emptyBasket) {
  let current = initial;
  const calls: any[] = [];
  const provider = new AhorramasProvider({
    async request(config: any) {
      calls.push(config);
      const headers = config.url === '/cart'
        ? { 'set-cookie': ['sid=abc123; Path=/', 'dwsid=secret; Path=/'] }
        : {};
      if (config.url === '/cart') {
        return { status: 200, data: JSON.stringify({ cart: current }), headers };
      }
      if (config.url.endsWith('Cart-AddProduct')) {
        current = fullBasket;
        return { status: 200, data: { cart: current }, headers };
      }
      if (config.url.endsWith('Cart-UpdateQuantity')) {
        current = {
          ...fullBasket,
          items: [{ ...basketLine, quantity: Number(config.params.quantityAbs) }],
          quantityTotal: Number(config.params.quantityAbs),
        };
        return { status: 200, data: { cart: current }, headers };
      }
      if (config.url.endsWith('Cart-RemoveProductLineItem')) {
        current = emptyBasket;
        return { status: 200, data: { cart: current }, headers };
      }
      throw new Error(`unexpected path ${config.url}`);
    },
  } as any);
  return { provider, calls };
}

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

async function main() {
  console.log('ahorramas provider');

  await check('parses multiple products and the normal product fields', () => {
    const products = parseSearchPage(fixture('ahorramas-products.html'));
    assert.strictEqual(products.length, 3);
    assert.deepStrictEqual(products[0], {
      product_uid: '70865',
      name: 'Leche Alipende 1l semidesnatada',
      retail_price: { price: 0.84 },
      unit_price: { measure: 'LITRO', price: 0.84 },
      in_stock: true,
      image_url: 'https://static.example.test/70865.jpg',
      provider: 'ahorramas',
      currency: 'EUR',
    });
  });

  await check('preserves an explicit out-of-stock value', () => {
    const products = parseSearchPage(fixture('ahorramas-products.html'));
    assert.strictEqual(products[1].in_stock, false);
    assert.deepStrictEqual(products[1].unit_price, { measure: 'KILO', price: 8.95 });
  });

  await check('allows products without optional fields or unit price', () => {
    const product = parseSearchPage(fixture('ahorramas-products.html'))[2];
    assert.strictEqual(product.product_uid, '90002');
    assert.strictEqual(product.unit_price, undefined);
    assert.strictEqual(product.image_url, undefined);
  });

  await check('parses comma and point decimal unit prices', () => {
    assert.deepStrictEqual(parseUnitPrice('0,84€/LITRO'), { measure: 'LITRO', price: 0.84 });
    assert.deepStrictEqual(parseUnitPrice('8.95€/KILO'), { measure: 'KILO', price: 8.95 });
    assert.deepStrictEqual(parseUnitPrice('2,50€/UNIDAD'), { measure: 'UNIDAD', price: 2.5 });
    assert.strictEqual(parseUnitPrice('2,50€'), undefined);
  });

  await check('returns an empty array for a genuine no-results page', () => {
    assert.deepStrictEqual(parseSearchPage(fixture('ahorramas-no-results.html')), []);
  });

  await check('rejects unexpected HTML instead of returning an empty array', () => {
    assert.throws(
      () => parseSearchPage(fixture('ahorramas-unexpected.html')),
      /unexpected search HTML/i
    );
  });

  await check('rejects an empty query before making an HTTP request', async () => {
    const provider = new AhorramasProvider();
    let called = false;
    (provider as any).fetchPage = async () => {
      called = true;
      return [];
    };
    await assert.rejects(() => provider.search('   '), /query must not be empty/i);
    assert.strictEqual(called, false);
  });

  await check('applies limit and offset without fetching another page', async () => {
    const provider = new AhorramasProvider();
    const pages = new Map<number, any[]>([
      [0, Array.from({ length: 20 }, (_, i) => ({ product_uid: String(i), name: `p${i}` }))],
    ]);
    const calls: number[] = [];
    (provider as any).fetchPage = async (_query: string, start: number) => {
      calls.push(start);
      return pages.get(start) ?? [];
    };
    const products = await provider.search('leche', { offset: 10, limit: 5 });
    assert.deepStrictEqual(products.map((product: any) => product.product_uid), ['10', '11', '12', '13', '14']);
    assert.deepStrictEqual(calls, [0]);
  });

  await check('walks upstream pages for a request larger than 20', async () => {
    const provider = new AhorramasProvider();
    const page = (start: number) => Array.from({ length: 20 }, (_, i) => ({
      product_uid: String(start + i),
      name: `p${start + i}`,
    }));
    const calls: number[] = [];
    (provider as any).fetchPage = async (_query: string, start: number) => {
      calls.push(start);
      return page(start);
    };
    const products = await provider.search('leche', { offset: 10, limit: 50 });
    assert.strictEqual(products.length, 50);
    assert.strictEqual(products[0].product_uid, '10');
    assert.strictEqual(products[49].product_uid, '59');
    assert.deepStrictEqual(calls, [0, 20, 40]);
  });

  await check('stops at a short upstream page', async () => {
    const provider = new AhorramasProvider();
    const calls: number[] = [];
    (provider as any).fetchPage = async (_query: string, start: number) => {
      calls.push(start);
      return Array.from({ length: 3 }, (_, i) => ({ product_uid: String(start + i), name: `p${i}` }));
    };
    const products = await provider.search('leche', { limit: 50 });
    assert.strictEqual(products.length, 3);
    assert.deepStrictEqual(calls, [0]);
  });

  await check('propagates HTTP status errors with provider context', async () => {
    const provider = new AhorramasProvider();
    (provider as any).http.get = async () => {
      const error: any = new Error('Request failed with status code 429');
      error.response = { status: 429 };
      error.isAxiosError = true;
      throw error;
    };
    await assert.rejects(() => provider.search('leche'), /AhorraMás search failed \(HTTP 429\)/);
  });

  await check('parses empty SSR baskets and rejects malformed SSR', () => {
    assert.deepStrictEqual(
      normaliseAhorramasBasket(parseAhorramasCartHtml('<script type="application/json">{"cart":{"items":[],"totals":{"total":"0,00"}}}</script>')).items,
      [],
    );
    assert.throws(() => parseAhorramasCartHtml('<html>unexpected upstream page</html>'), AhorramasParseError);
  });

  await check('parses Spanish prices and promotional sales prices', () => {
    assert.strictEqual(parseAhorramasPrice('1.234,56€'), 1234.56);
    const basket = normaliseAhorramasBasket(fullBasket);
    assert.strictEqual(basket.items[0].unit_price, 1.49);
    assert.strictEqual(basket.items[0].total_price, 2.98);
  });

  await check('adds and reads an anonymous basket with shared cookies', async () => {
    const { provider, calls } = fakeBasketProvider();
    await provider.getBasket();
    await provider.addToBasket('70865', 2);
    const basket = await provider.getBasket();
    assert.strictEqual(basket.items[0].product_uid, '70865');
    assert.match(String(calls[1].headers.Cookie), /sid=abc123/);
    assert.doesNotMatch(JSON.stringify(basket), /abc123|secret/);
    assert.match(String(calls[1].data), /pid=70865/);
    assert.match(String(calls[1].data), /childProducts=%5B%5D/);
  });

  await check('updates quantity absolutely and distinguishes pid from UUID', async () => {
    const { provider, calls } = fakeBasketProvider(fullBasket);
    await provider.updateBasketItem('line-uuid-1', 1);
    const update = calls[1];
    assert.deepStrictEqual(update.params, {
      pid: '70865', quantity: 1, quantityAbs: 1, uuid: 'line-uuid-1',
    });
    assert.strictEqual((await provider.getBasket()).items[0].quantity, 1);
  });

  await check('removes a line using product id and UUID', async () => {
    const { provider, calls } = fakeBasketProvider(fullBasket);
    await provider.removeFromBasket('line-uuid-1');
    assert.deepStrictEqual(calls[1].params, { pid: '70865', uuid: 'line-uuid-1' });
  });

  await check('clears every line and propagates partial failures', async () => {
    const lines = [
      { ...basketLine, UUID: 'line-1', id: '70865' },
      { ...basketLine, UUID: 'line-2', id: '90002' },
    ];
    const calls: any[] = [];
    const provider = new AhorramasProvider({
      async request(config: any) {
        calls.push(config);
        if (config.url === '/cart') {
          return { data: JSON.stringify({ cart: { items: lines, totals: { total: '5,96' } } }), headers: {} };
        }
        if (config.params.uuid === 'line-2') {
          const error: any = new Error('second line failed');
          error.response = { status: 500, data: { error: 'line removal failed' } };
          throw error;
        }
        return { data: {}, headers: {} };
      },
    } as any);
    await assert.rejects(provider.clearBasket(), /line removal failed/);
    assert.deepStrictEqual(
      calls.filter((call) => call.url.endsWith('Cart-RemoveProductLineItem')).map((call) => call.params.uuid),
      ['line-1', 'line-2'],
    );
  });

  await check('rejects non-positive quantities before HTTP', async () => {
    const { provider, calls } = fakeBasketProvider();
    await assert.rejects(provider.addToBasket('70865', 0), /greater than zero/);
    await assert.rejects(provider.updateBasketItem('line-uuid-1', -1), /greater than zero/);
    assert.strictEqual(calls.length, 0);
  });

  await check('keeps basket HTTP 5xx and malformed responses as errors', async () => {
    const httpError = new AhorramasProvider({
      async request() {
        const error: any = new Error('server');
        error.response = { status: 500, data: { error: 'cart unavailable' } };
        throw error;
      },
    } as any);
    await assert.rejects(
      httpError.getBasket!(),
      (error: any) => error instanceof AhorramasHttpError && error.status === 500 && /cart unavailable/.test(error.message),
    );

    const malformed = new AhorramasProvider({
      async request() { return { data: '<html>not a basket</html>', headers: {} }; },
    } as any);
    await assert.rejects(malformed.getBasket!(), AhorramasParseError);
  });

  await check('registry declares anonymous search and basket', async () => {
    const { getManifest, createProvider } = await import('../src/providers/registry');
    const manifest = getManifest('ahorramas');
    assert.deepStrictEqual(manifest.capabilities, ['search', 'basket']);
    assert.strictEqual(manifest.auth, 'anonymous');
    assert.strictEqual((await createProvider('ahorramas')).name, 'ahorramas');
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
