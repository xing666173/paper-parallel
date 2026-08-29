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
  return `#set page(
  width: ${points(options.paperWidth)},
  height: ${points(options.paperHeight)},
  margin: ${points(margin)},
  footer: context [#counter(page).display()],
)
#set text(font: ("Noto Serif SC", "DejaVu Math TeX Gyre", "DejaVu Serif"), size: 10pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.1")

#let pp-full-width(body) = body
#let pp-double(body) = columns(2, gutter: ${points(gutter)})[#body]
#let pp-single(body) = body
#let pp-unit(id, body) = link("https://paper-parallel.invalid/unit/" + id)[#body]
#let pp-title(body) = block(above: 4pt, below: 8pt)[#align(center)[#text(size: 16pt, weight: "bold")[#body]]]
#let pp-author(body) = block(below: 3pt)[#align(center)[#text(size: 10pt)[#body]]]
#let pp-heading(body) = block(above: 7pt, below: 3pt)[#text(size: 12pt, weight: "bold")[#body]]
#let pp-caption(body) = block(above: 3pt, below: 5pt)[#align(center)[#text(size: 9pt, weight: "bold")[#body]]]
#let pp-reference(body) = text(size: 9pt)[#body]
#let pp-asset-group(body) = block(breakable: false, width: 100%, above: 2pt, below: 4pt)[#body]
#let pp-asset(id, path, source-width, span: false) = {
  let body = block(breakable: false, width: 100%)[#align(center)[#pp-unit(id)[#image(path, width: source-width)]]]
  if span { pp-full-width(body) } else { body }
}
`;
}
