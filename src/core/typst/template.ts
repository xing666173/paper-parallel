export interface AcademicTemplateOptions {
  paperWidth: number;
  paperHeight: number;
  margin?: number;
  columnGap?: number;
}

function points(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Paper dimensions must be positive');
  return `${value}pt`;
}

export function buildAcademicTemplate(options: AcademicTemplateOptions): string {
  const margin = options.margin ?? Math.max(36, options.paperWidth * 0.1);
  const gutter = options.columnGap ?? 12;
  return `#set page(width: ${points(options.paperWidth)}, height: ${points(options.paperHeight)}, margin: ${points(margin)})
#set text(font: ("Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC"), size: 10pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.1")

#let pp-full-width(body) = block(width: 100%)[#body]
#let pp-double(body) = columns(2, gutter: ${points(gutter)})[#body]
#let pp-single(body) = block(width: 100%)[#body]
#let pp-unit(id, body) = link("https://paper-parallel.invalid/unit/" + id)[#body]
#let pp-asset(id, path, span: false) = {
  let body = pp-unit(id)[#image(path, width: 100%)]
  if span { pp-full-width(body) } else { body }
}
`;
}
