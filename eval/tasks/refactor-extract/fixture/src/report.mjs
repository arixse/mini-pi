export function formatUser(user) {
  const name = `${user.lastName}, ${user.firstName}`;
  return `用户 ${name} (${user.role})`;
}

export function formatAdmin(user) {
  const name = `${user.lastName}, ${user.firstName}`;
  return `管理员 ${name} (${user.role})`;
}
