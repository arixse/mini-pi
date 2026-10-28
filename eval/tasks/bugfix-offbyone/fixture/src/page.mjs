/**
 * 把数组切成固定大小的页。
 *
 * 页码从 1 开始。现状：第一页取不到数据，最后一页还会越界。
 */
export function page(items, size, pageNumber) {
  const start = pageNumber * size;
  return items.slice(start, start + size);
}
