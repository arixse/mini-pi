import { displayName } from "./name.mjs";

export function formatUser(user) {
  return `用户 ${displayName(user)} (${user.role})`;
}

export function formatAdmin(user) {
  return `管理员 ${displayName(user)} (${user.role})`;
}
