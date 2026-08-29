export function escapeTypstText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([#$\[\]<>@*_`/])/g, '\\$1');
}

export function escapeTypstString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
