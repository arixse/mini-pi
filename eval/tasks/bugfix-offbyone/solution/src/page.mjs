/**
 * 把数组切成固定大小的页。
 *
 * 页码从 1 开始；非法页参数返回空数组，而不是把负数下标交给 slice。
 */
export function page(items, size, pageNumber) {
  if (!Number.isInteger(size) || size <= 0) {
    return [];
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return [];
  }
  const start = (pageNumber - 1) * size;
  return items.slice(start, start + size);
}
