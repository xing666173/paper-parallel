import { readFile, writeFile } from 'node:fs/promises';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/build-single-column-typst-prototype.mjs <input.typ> <output.typ>');
}

let source = await readFile(inputPath, 'utf8');
source = source
  .replace(
    /#let pp-double\(body\) = columns\(2, gutter: [^)]+\)\[#body\]/,
    '#let pp-double(body) = body',
  )
  .replaceAll('#colbreak()', '')
  .replace('size: 10pt)', 'size: 10.5pt)')
  .replace(
    '#set par(justify: true, leading: 0.65em)',
    `#set par(
  justify: true,
  leading: 1em,
  spacing: 0.42em,
  first-line-indent: (amount: 2em, all: true),
)`,
  )
  .replace(
    '#let pp-title(body) = block(above: 4pt, below: 8pt)[#align(center)[#text(size: 16pt, weight: "bold")[#body]]]',
    `#let pp-title(body) = {
  set par(first-line-indent: 0pt, leading: 0.35em)
  block(width: 100%, above: 4pt, below: 10pt)[#align(center)[#text(size: 17pt, weight: "bold")[#body]]]
}`,
  )
  .replace(
    '#let pp-author(body) = block(below: 3pt)[#align(center)[#text(size: 10pt)[#body]]]',
    `#let pp-author(body) = {
  set par(first-line-indent: 0pt, leading: 0.45em)
  block(width: 100%, below: 3pt)[#align(center)[#text(size: 10pt)[#body]]]
}`,
  )
  .replace(
    '#let pp-heading(body) = block(above: 7pt, below: 3pt)[#text(size: 12pt, weight: "bold")[#body]]',
    `#let pp-heading(body) = {
  set par(first-line-indent: 0pt, leading: 0.35em)
  block(width: 100%, sticky: true, above: 14pt, below: 8pt)[#text(size: 13pt, weight: "bold")[#body]]
}
#let pp-subheading(body) = {
  set par(first-line-indent: 0pt, leading: 0.35em)
  block(width: 100%, sticky: true, above: 10pt, below: 7pt)[#text(size: 11.5pt, weight: "bold")[#body]]
}`,
  )
  .replace(
    '#let pp-caption(body) = block(above: 3pt, below: 5pt)[#align(center)[#text(size: 9pt, weight: "bold")[#body]]]',
    `#let pp-caption(body) = {
  set par(first-line-indent: 0pt, leading: 0.4em)
  block(width: 100%, above: 4pt, below: 8pt)[#align(center)[#text(size: 9pt)[#body]]]
}`,
  )
  .replace(
    'set par(spacing: 1pt)',
    'set par(leading: 0.4em, spacing: 1.5pt, first-line-indent: 0pt, hanging-indent: 1.4em)',
  );

function wrapFrontMatterUnit(id) {
  const pattern = new RegExp(`#pp-unit\\("${id}"\\)\\[([\\s\\S]*?)\\](?=\\r?\\n\\r?\\n)`);
  source = source.replace(pattern, `#pp-author[#pp-unit("${id}")[$1]]`);
}

for (const id of [
  'blk-2-g-1-t-1',
  'blk-4-g-1-t-1',
  'blk-6-g-1-t-1',
]) {
  wrapFrontMatterUnit(id);
}
source = source
  .replace(
    /#pp-reference\[#pp-unit\("blk-7"\)\[([\s\S]*?)\]\]/,
    '#pp-author[#pp-unit("blk-7")[$1]]',
  )
  .replace(
    '#pp-unit("blk-8-g-1-t-1")[摘要\n',
    '#pp-unit("blk-8-g-1-t-1")[#text(weight: "bold")[摘要] ',
  )
  .replace(
    '#pp-unit("blk-8-g-8-t-1")[关键词\n',
    '#pp-unit("blk-8-g-8-t-1")[#text(weight: "bold")[关键词] ',
  )
  .replace(
    '#pp-heading[#pp-unit("blk-15-g-1-t-1")[2 动机与相关工作 2.1 ZKP瓶颈转移现象]]',
    '#pp-heading[#pp-unit("blk-15-g-1-t-1")[2 动机与相关工作]]\n#pp-subheading[#pp-unit("blk-15-subheading-1")[2.1 ZKP瓶颈转移现象]]',
  )
  .replace(
    '#pp-heading[#pp-unit("blk-28-g-1-t-1")[3 设计与理念\n3.1 架构与工作流程]]',
    '#pp-heading[#pp-unit("blk-28-g-1-t-1")[3 设计与理念]]\n#pp-subheading[#pp-unit("blk-28-subheading-1")[3.1 架构与工作流程]]',
  )
  .replace(
    '#pp-heading[#pp-unit("blk-46-g-1-t-1")[4 评估\n4.1 实验设置]]',
    '#pp-heading[#pp-unit("blk-46-g-1-t-1")[4 评估]]\n#pp-subheading[#pp-unit("blk-46-subheading-1")[4.1 实验设置]]',
  )
  .replace(
    '#pp-heading[#pp-unit("blk-65-g-1-t-1")[结论 5]]',
    '#pp-heading[#pp-unit("blk-65-g-1-t-1")[5 结论]]',
  );

source = source.replace(
  /#pp-heading\[(#pp-unit\("[^"]+"\)\[(?:\d+\.\d+(?:\.\d+)?)[^\]]*\])\]/g,
  '#pp-subheading[$1]',
);

source = source
  .replace(
    '\n\n#pp-title[',
    `
#let pp-display-formula(id, body) = {
  set par(first-line-indent: 0pt)
  block(breakable: false, width: 100%, above: 4pt, below: 6pt)[
    #align(center)[#pp-unit(id)[#body]]
  ]
}

#pp-title[`,
  )
  .replace(
    '#pp-asset("vision-p2-formula-2", "/assets/vision-p2-formula-2.png", 238.8pt, span: false)',
    '#pp-display-formula("vision-p2-formula-2")[Permutation#sub[i] = 1 / (γ + Σ#sub[j] β#super[j] A#sub[ij])　　Sum#sub[i] = Σ#sub[k=1]#super[i] Permutation#sub[i]　　(1)]',
  );

const readableFigures = [
  'vision-p1-figure-1',
  'vision-p2-figure-1',
  'vision-p3-figure-1',
  'vision-p3-figure-2',
  'vision-p4-figure-2',
  'vision-p5-figure-1',
  'vision-p5-figure-2',
];
const readableTables = [
  'vision-p5-table-3',
];
for (const id of readableFigures) {
  source = source.replace(
    new RegExp(`(#pp-asset\\("${id}",\\s*"/assets/${id}\\.png",\\s*)[0-9.]+pt`),
    '$1381.89pt',
  );
}
for (const id of readableTables) {
  source = source.replace(
    new RegExp(`(#pp-asset\\("${id}",\\s*"/assets/${id}\\.png",\\s*)[0-9.]+pt`),
    '$1440.64pt',
  );
}

if (source.includes('#colbreak()') || /#let pp-double\(body\) = columns/.test(source)) {
  throw new Error('The source still contains inherited two-column controls');
}
await writeFile(outputPath, source, 'utf8');
