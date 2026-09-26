/**
 * AhorraMás (Spain) — anonymous server-rendered catalogue search.
 *
 * AhorraMás uses Salesforce Commerce Cloud (Demandware). The public search
 * page and its pagination fragments contain the product data needed by the
 * search-only provider, so no browser, login, cookie jar or postcode is
 * required here. Store selection can affect availability and basket behaviour
 * and is deliberately outside this first implementation.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { Basket, BasketItem, GroceryProvider, Product, SearchOptions } from './types';

export const AHORRAMAS_BASE = 'https://www.ahorramas.com';
export const AHORRAMAS_SITE = 'Sites-Ahorramas-Site';
export const AHORRAMAS_LOCALE = 'es';
const SEARCH_PATH = '/buscador';
const GRID_PATH =
  '/on/demandware.store/Sites-Ahorramas-Site/es/Search-UpdateGrid';
const STORE_PATH = `/on/demandware.store/${AHORRAMAS_SITE}/${AHORRAMAS_LOCALE}`;
export const AHORRAMAS_PAGE_SIZE = 20;

type HttpResponse = Pick<AxiosResponse, 'data' | 'headers' | 'status'>;

export class AhorramasHttpError extends Error {
  readonly status?: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status?: number, cause?: unknown) {
    const detail = safeErrorDetail(cause);
    super(`AhorraMás ${method} ${path} failed${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'AhorramasHttpError';
    this.status = status;
    this.method = method;
    this.path = path;
    if (cause) (this as any).cause = cause;
  }
}

export class AhorramasParseError extends Error {
  constructor(message: string) {
    super(`AhorraMás basket response could not be parsed: ${message}`);
    this.name = 'AhorramasParseError';
  }
}

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  text: string;
}

interface UnitPrice {
  measure: string;
  price: number;
}

interface JsonLdProduct {
  url?: string;
  sku?: string;
  mpn?: string;
  name?: string;
  description?: string;
  image?: string | string[];
  offers?: {
    price?: string | number;
    priceCurrency?: string;
    availability?: string;
  };
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCharCode(parseInt(code, 16))
    );
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let index = 0;

  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index++;
    if (index >= source.length || source[index] === '/' || source[index] === '>') break;

    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index++;
    const name = source.slice(nameStart, index).toLowerCase();
    if (!name) {
      index++;
      continue;
    }

    while (/\s/.test(source[index] ?? '')) index++;
    let value = '';
    if (source[index] === '=') {
      index++;
      while (/\s/.test(source[index] ?? '')) index++;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index++;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index++;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index++;
      } else {
        const valueStart = index;
        while (index < source.length && !/[\s>]/.test(source[index])) index++;
        value = source.slice(valueStart, index);
      }
    }
    attrs[name] = decodeHtml(value);
  }

  return attrs;
}

/** A deliberately small HTML tree builder for the stable semantic markup used by the tiles. */
function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: HtmlNode[] = [root];
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(html))) {
    const directText = decodeHtml(html.slice(cursor, match.index));
    if (directText) stack[stack.length - 1].text += directText;

    const raw = match[0];
    if (raw.startsWith('<!--') || raw.startsWith('<!')) {
      cursor = token.lastIndex;
      continue;
    }

    if (raw.startsWith('</')) {
      const closingTag = raw.slice(2, -1).trim().toLowerCase();
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tag === closingTag) {
          stack.length = index;
          break;
        }
      }
      cursor = token.lastIndex;
      continue;
    }

    const body = raw.slice(1, -1);
    const nameMatch = body.match(/^\s*([A-Za-z][\w:-]*)/);
    if (!nameMatch) {
      cursor = token.lastIndex;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const node: HtmlNode = {
      tag,
      attrs: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!raw.endsWith('/>') && !VOID_TAGS.has(tag)) stack.push(node);
    cursor = token.lastIndex;
  }

  const trailingText = decodeHtml(html.slice(cursor));
  if (trailingText) stack[stack.length - 1].text += trailingText;
  return root;
}

function classList(node: HtmlNode): string[] {
  return (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
}

function hasClass(node: HtmlNode, name: string): boolean {
  return classList(node).includes(name);
}

function findAll(node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (candidate: HtmlNode) => {
    if (predicate(candidate)) found.push(candidate);
    for (const child of candidate.children) visit(child);
  };
  visit(node);
  return found;
}

function findFirst(node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function textContent(node: HtmlNode | undefined): string {
  if (!node) return '';
  return `${node.text} ${node.children.map(textContent).join(' ')}`
    .replace(/\s+/g, ' ')
    .trim();
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const cleaned = value.replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!cleaned) return undefined;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = cleaned.replace(',', '.');
  }

  const result = Number(normalized);
  return Number.isFinite(result) ? result : undefined;
}

/** Parse a rendered value such as "0,84€" or "1.234,56 EUR". */
export function parsePrice(value: string | number | undefined): number | undefined {
  return numericValue(value);
}

/** Parse the retailer's rendered price-per-unit label into Product.unit_price. */
export function parseUnitPrice(value: string | undefined): UnitPrice | undefined {
  if (!value) return undefined;
  const match = value.match(
    /([\d.,]+)\s*(?:€|EUR)?\s*\/\s*(LITRO?|L|KILO?|KG|UNIDAD(?:ES)?|UDS?|U)\b/i
  );
  if (!match) return undefined;

  const price = parsePrice(match[1]);
  if (price === undefined) return undefined;

  const rawMeasure = match[2].toUpperCase();
  const measure = rawMeasure.startsWith('L') ? 'LITRO' :
    rawMeasure.startsWith('K') ? 'KILO' : 'UNIDAD';
  return { measure, price };
}

function parseAvailability(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized.includes('instock')) return true;
  if (normalized === 'false' || normalized.includes('outofstock')) return false;
  return undefined;
}

function parseJsonLd(root: HtmlNode): JsonLdProduct[] {
  const scripts = findAll(
    root,
    (node) => node.tag === 'script' && node.attrs.type === 'application/ld+json'
  );
  const products: JsonLdProduct[] = [];

  for (const script of scripts) {
    try {
      const value = JSON.parse(script.text.trim());
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        if (candidate?.['@type'] === 'Product') products.push(candidate as JsonLdProduct);
        for (const item of candidate?.itemListElement ?? []) {
          if (item?.item?.['@type'] === 'Product') products.push(item.item as JsonLdProduct);
        }
      }
    } catch {
      // A broken optional JSON-LD block must not hide otherwise parseable tiles.
    }
  }
  return products;
}

function fallbackJsonLd(tile: HtmlNode, products: JsonLdProduct[]): JsonLdProduct | undefined {
  const id = tile.attrs['data-pid'];
  const link = findFirst(tile, (node) => node.tag === 'a' && !!node.attrs.href)?.attrs.href;
  return products.find((product) =>
    String(product.sku ?? product.mpn ?? '') === id ||
    (link && String(product.url ?? '') === link)
  );
}

/** Convert one semantic .product tile into the repository's Product shape. */
export function parseProductTile(
  tile: HtmlNode | string,
  jsonLdProducts: JsonLdProduct[] = []
): Product {
  const node = typeof tile === 'string' ? parseHtml(tile) : tile;
  const product = hasClass(node, 'product') ? node :
    findFirst(node, (candidate) => hasClass(candidate, 'product'));
  if (!product) throw new Error('AhorraMás product tile is missing .product');

  const structured = fallbackJsonLd(product, jsonLdProducts);
  const productId = product.attrs['data-pid'] ?? structured?.sku ?? structured?.mpn;
  const nameNode = findFirst(product, (candidate) =>
    candidate.tag === 'h2' && hasClass(candidate, 'product-name-gtm')
  );
  const link = findFirst(product, (candidate) =>
    candidate.tag === 'a' && hasClass(candidate, 'product-pdp-link')
  );
  const name = textContent(nameNode) || textContent(link) || structured?.name?.trim();
  const priceNode = findFirst(product, (candidate) =>
    candidate.tag === 'span' && hasClass(candidate, 'value') && candidate.attrs.content !== undefined
  );
  const price = parsePrice(priceNode?.attrs.content ??
    findFirst(product, (candidate) => hasClass(candidate, 'add-to-cart'))?.attrs['data-price'] ??
    structured?.offers?.price);
  const availabilityNode = findFirst(product, (candidate) =>
    hasClass(candidate, 'add-to-cart') && candidate.attrs['data-available'] !== undefined
  );
  const inStock = parseAvailability(
    availabilityNode?.attrs['data-available'] ?? structured?.offers?.availability
  );
  const unitPrice = parseUnitPrice(
    textContent(findFirst(product, (candidate) => hasClass(candidate, 'unit-price-per-unit')))
  );
  const image = findFirst(product, (candidate) =>
    candidate.tag === 'img' && (candidate.attrs.itemprop === 'image' || candidate.attrs.src !== undefined)
  );

  if (!productId || !name || price === undefined || inStock === undefined) {
    throw new Error(
      'AhorraMás returned a product tile without a product id, name, price or explicit availability'
    );
  }

  const result: Product = {
    product_uid: String(productId),
    name,
    retail_price: { price },
    in_stock: inStock,
    provider: 'ahorramas',
    currency: structured?.offers?.priceCurrency ?? 'EUR',
  };
  if (unitPrice) result.unit_price = unitPrice;

  const description = structured?.description?.trim();
  if (description) result.description = description;
  const size = product.attrs['data-size'] ?? product.attrs['data-unitdata'];
  if (size) result.size = size;
  const imageUrl = image?.attrs.src ?? image?.attrs['data-src'] ??
    (Array.isArray(structured?.image) ? structured?.image[0] : structured?.image);
  if (imageUrl) result.image_url = imageUrl;
  return result;
}

/** Parse a full search page or a Search-UpdateGrid HTML fragment. */
export function parseSearchPage(html: string): Product[] {
  if (!html || typeof html !== 'string') {
    throw new Error('AhorraMás returned an empty or non-HTML response');
  }

  const root = parseHtml(html);
  const tiles = findAll(root, (node) =>
    hasClass(node, 'product') && node.attrs['data-pid'] !== undefined
  );
  if (tiles.length === 0) {
    const pageText = textContent(root).toLowerCase();
    if (
      pageText.includes('sin resultados') ||
      pageText.includes('no hemos encontrado') ||
      /no\s+(?:se\s+han\s+)?encontrado[\s\S]*resultados/.test(pageText)
    ) return [];
    throw new Error('AhorraMás returned unexpected search HTML: no product tiles found');
  }

  const jsonLdProducts = parseJsonLd(root);
  return tiles.map((tile) => parseProductTile(tile, jsonLdProducts));
}

function safeErrorDetail(error: any): string {
  const value = error?.response?.data;
  const detail = typeof value === 'string'
    ? value
    : value?.error ?? value?.errorMessage ?? value?.message;
  if (typeof detail !== 'string' || !detail.trim()) return '';
  return detail
    .replace(/((?:sid|dwsid|dwanonymous_[^=;\s]*|dwac_[^=;\s]*))=[^;\s]+/gi, '$1=[redacted]')
    .slice(0, 240);
}

/** Parse Spanish/euro prices without changing the process locale. */
export function parseAhorramasPrice(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(/[€$£]/g, '');
  if (!text) return 0;
  const normalised = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  const parsed = Number(normalised.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function basketNumber(value: unknown): number {
  return typeof value === 'number'
    ? (Number.isFinite(value) ? value : 0)
    : parseAhorramasPrice(value);
}

function quantityTotal(value: unknown, items: BasketItem[]): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>).map(basketNumber);
    if (values.length) return values.reduce((sum, quantity) => sum + quantity, 0);
  }
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function jsonCandidates(html: string): any[] {
  const values: any[] = [];
  const patterns = [
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      try { values.push(JSON.parse(match[1])); } catch { /* unrelated page JSON */ }
    }
  }
  return values;
}

/** Extract basket state from JSON, SSR JSON, or a JSON data attribute. */
export function parseAhorramasCartHtml(html: string): any {
  try {
    const json = JSON.parse(html);
    if (json && typeof json === 'object') return json;
  } catch { /* /cart may return SSR HTML */ }

  for (const candidate of jsonCandidates(html)) {
    if (candidate?.cart || candidate?.basket || candidate?.items || candidate?.products) return candidate;
    const nested = candidate?.data?.cart ?? candidate?.data?.basket;
    if (nested) return { cart: nested };
  }

  const state = html.match(/(?:data-cart|data-basket|data-cart-state)=["']([^"']+)["']/i);
  if (state) {
    try { return JSON.parse(state[1].replace(/&quot;/g, '"')); } catch { /* malformed state */ }
  }
  throw new AhorramasParseError('no basket state was found in the SSR document');
}

export function normaliseAhorramasBasket(raw: any, provider = 'ahorramas'): Basket {
  const cart = raw?.cart ?? raw?.basket ?? raw ?? {};
  const sourceItems = Array.isArray(cart.items)
    ? cart.items
    : Array.isArray(cart.products) ? cart.products : [];
  const items = sourceItems.map((item: any): BasketItem => {
    const product = item?.product ?? item;
    const quantity = basketNumber(item?.quantity ?? item?.qty ?? 1);
    const unit = item?.unitPrice?.sales?.value
      ?? item?.unitPrice?.value
      ?? item?.unitPrice
      ?? item?.price?.sales?.value
      ?? item?.price;
    const total = item?.priceTotal?.decimalPrice
      ?? item?.priceTotal?.value
      ?? item?.totalPrice
      ?? item?.subtotal
      ?? item?.price?.sales?.value;
    return {
      item_id: String(item?.UUID ?? item?.uuid ?? item?.item_id ?? item?.itemId ?? ''),
      product_uid: String(item?.id ?? item?.productId ?? product?.id ?? product?.productId ?? ''),
      name: String(item?.productName ?? product?.productName ?? product?.name ?? 'Unknown item'),
      quantity,
      unit_price: basketNumber(unit),
      total_price: total === undefined ? basketNumber(unit) * quantity : basketNumber(total),
    };
  });
  const totals = cart.totals ?? raw?.totals ?? {};
  const total = totals.total ?? totals.grandTotal ?? totals.orderTotal ?? totals.totalPrice;
  return {
    items,
    total_quantity: quantityTotal(cart.quantityTotal ?? cart.quantityTotalByUnit, items),
    total_cost: total === undefined ? basketNumber(totals.subTotal ?? totals.subtotal) : basketNumber(total),
    provider,
    currency: 'EUR',
  };
}

function errorMessage(error: unknown, action: string): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return new Error(
      `AhorraMás ${action} failed${status ? ` (HTTP ${status})` : ''}: ${error.message}`
    );
  }
  return error instanceof Error ? error : new Error(`AhorraMás ${action} failed: ${String(error)}`);
}

export class AhorramasProvider implements GroceryProvider {
  readonly name = 'ahorramas';

  private readonly http: AxiosInstance;
  private readonly cookies = new Map<string, string>();

  constructor(http?: AxiosInstance) {
    this.http = http ?? axios.create({
      baseURL: AHORRAMAS_BASE,
      timeout: 15_000,
      headers: { Accept: 'text/html, application/json' },
    });
  }

  private captureCookies(headers: any): void {
    const values = headers?.['set-cookie'] ?? headers?.['Set-Cookie'];
    for (const raw of Array.isArray(values) ? values : values ? [values] : []) {
      const pair = String(raw).split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private async request<T = any>(config: AxiosRequestConfig): Promise<HttpResponse & { data: T }> {
    const cookie = this.cookieHeader();
    const headers = {
      ...(config.headers as any),
      ...(cookie ? { Cookie: cookie } : {}),
    };
    try {
      const response = await this.http.request<T>({ ...config, headers });
      this.captureCookies(response.headers);
      return response as HttpResponse & { data: T };
    } catch (error: any) {
      throw new AhorramasHttpError(
        String(config.method ?? 'GET').toUpperCase(),
        String(config.url),
        error?.response?.status,
        error,
      );
    }
  }

  private async fetchPage(query: string, start: number): Promise<Product[]> {
    const isInitialPage = start === 0;
    try {
      const response = await this.http.get<string>(isInitialPage ? SEARCH_PATH : GRID_PATH, {
        params: isInitialPage
          ? { q: query }
          : { q: query, pmin: 0.01, start, sz: AHORRAMAS_PAGE_SIZE },
        responseType: 'text',
      });
      if (typeof response.data !== 'string') {
        throw new Error('AhorraMás returned a non-HTML response');
      }
      this.captureCookies(response.headers);
      return parseSearchPage(response.data);
    } catch (error) {
      throw errorMessage(error, 'search');
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error('AhorraMás search query must not be empty');
    }
    if (options.category) {
      throw new Error('AhorraMás category filtering is not implemented yet');
    }

    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('AhorraMás search limit must be a non-negative integer');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('AhorraMás search offset must be a non-negative integer');
    }
    if (limit === 0) return [];

    const firstStart = Math.floor(offset / AHORRAMAS_PAGE_SIZE) * AHORRAMAS_PAGE_SIZE;
    const results: Product[] = [];
    let start = firstStart;

    while (results.length < limit) {
      const page = await this.fetchPage(normalizedQuery, start);
      if (page.length === 0) break;

      const pageOffset = Math.max(offset - start, 0);
      results.push(...page.slice(pageOffset, pageOffset + (limit - results.length)));
      if (page.length < AHORRAMAS_PAGE_SIZE) break;
      start += AHORRAMAS_PAGE_SIZE;
    }

    return results.slice(0, limit);
  }

  async getBasket(): Promise<Basket> {
    const response = await this.request<any>({ method: 'GET', url: '/cart' });
    const raw = typeof response.data === 'string'
      ? parseAhorramasCartHtml(response.data)
      : response.data;
    return normaliseAhorramasBasket(raw, this.name);
  }

  private async findBasketItem(itemId: string): Promise<BasketItem> {
    const basket = await this.getBasket();
    const item = basket.items.find((candidate) =>
      candidate.item_id === itemId || candidate.product_uid === itemId
    );
    if (!item) throw new Error(`AhorraMás basket line ${itemId} not found`);
    return item;
  }

  private validateQuantity(quantity: number): void {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('AhorraMás: quantity must be greater than zero');
    }
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    this.validateQuantity(quantity);
    await this.request({
      method: 'POST',
      url: `${STORE_PATH}/Cart-AddProduct`,
      data: new URLSearchParams({
        pid: productId,
        quantity: String(quantity),
        childProducts: '[]',
      }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    this.validateQuantity(quantity);
    const item = await this.findBasketItem(itemId);
    await this.request({
      method: 'GET',
      url: `${STORE_PATH}/Cart-UpdateQuantity`,
      params: {
        pid: item.product_uid,
        quantity,
        quantityAbs: quantity,
        uuid: item.item_id,
      },
    });
  }

  async removeFromBasket(itemId: string): Promise<void> {
    const item = await this.findBasketItem(itemId);
    await this.request({
      method: 'GET',
      url: `${STORE_PATH}/Cart-RemoveProductLineItem`,
      params: { pid: item.product_uid, uuid: item.item_id },
    });
  }

  async clearBasket(): Promise<void> {
    const basket = await this.getBasket();
    for (const item of basket.items) await this.removeFromBasket(item.item_id);
  }
}
