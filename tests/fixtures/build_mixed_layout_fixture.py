"""Build a deterministic text-layer PDF used by the browser workflow test."""

from pathlib import Path

from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


OUTPUT = Path(__file__).with_name("mixed-layout-paper.pdf")
PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 48
GUTTER = 20
COLUMN_WIDTH = (PAGE_WIDTH - 2 * MARGIN - GUTTER) / 2


def centered_text(pdf: canvas.Canvas, text: str, y: float, font: str, size: float) -> None:
    pdf.setFont(font, size)
    pdf.drawString((PAGE_WIDTH - stringWidth(text, font, size)) / 2, y, text)


def wrapped_text(
    pdf: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    font: str = "Times-Roman",
    size: float = 9.4,
    leading: float = 12.2,
) -> float:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and stringWidth(candidate, font, size) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)

    pdf.setFillColor(black)
    pdf.setFont(font, size)
    for line in lines:
        pdf.drawString(x, y, line)
        y -= leading
    return y


def draw_immutable_figure(pdf: canvas.Canvas, x: float, y: float, width: float, height: float) -> None:
    """Draw vector-only content so its appearance must be preserved as an image crop."""
    pdf.saveState()
    pdf.setStrokeColor(HexColor("#23395d"))
    pdf.setFillColor(HexColor("#eaf2ff"))
    pdf.roundRect(x, y, width, height, 8, fill=1, stroke=1)

    box_w = 52
    box_h = 28
    box_y = y + (height - box_h) / 2
    positions = [x + 18, x + (width - box_w) / 2, x + width - box_w - 18]
    fills = ["#d5e8ff", "#dff6e5", "#fff0cc"]
    for pos, fill in zip(positions, fills):
        pdf.setFillColor(HexColor(fill))
        pdf.roundRect(pos, box_y, box_w, box_h, 5, fill=1, stroke=1)
    pdf.setFillColor(HexColor("#23395d"))
    for start, end in zip(positions, positions[1:]):
        x1 = start + box_w
        x2 = end
        mid_y = box_y + box_h / 2
        pdf.line(x1 + 3, mid_y, x2 - 3, mid_y)
        pdf.line(x2 - 8, mid_y + 4, x2 - 3, mid_y)
        pdf.line(x2 - 8, mid_y - 4, x2 - 3, mid_y)
    pdf.restoreState()


def build() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(OUTPUT), pagesize=A4, pageCompression=1)
    pdf.setTitle("Mixed Layout Translation Fixture")
    pdf.setAuthor("Paper Parallel Test Suite")

    centered_text(pdf, "A Browser-Native Pipeline for Faithful Paper Translation", 790, "Times-Bold", 15)
    centered_text(pdf, "Alice Example, Bob Example", 767, "Times-Roman", 10.5)
    centered_text(pdf, "Systems Research Laboratory, Example University", 752, "Times-Italic", 9.5)

    y = 724
    y = wrapped_text(
        pdf,
        "Abstract: Academic paper translation must preserve technical meaning, immutable visual assets, and the source layout while allowing natural pagination in the target language.",
        MARGIN,
        y,
        PAGE_WIDTH - 2 * MARGIN,
        "Times-Roman",
        9.7,
        12.5,
    )
    y -= 7
    y = wrapped_text(
        pdf,
        "Keywords: document translation, layout inheritance, semantic alignment",
        MARGIN,
        y,
        PAGE_WIDTH - 2 * MARGIN,
        "Times-Roman",
        9.4,
        12,
    )

    column_top = y - 16
    left_x = MARGIN
    right_x = MARGIN + COLUMN_WIDTH + GUTTER

    pdf.setFont("Times-Bold", 11.5)
    pdf.drawString(left_x, column_top, "1 Introduction")
    left_y = column_top - 20
    left_y = wrapped_text(
        pdf,
        "Modern systems papers combine prose with figures, tables, formulas, citations, and code. A faithful workflow translates the prose but leaves every immutable technical object unchanged [1].",
        left_x,
        left_y,
        COLUMN_WIDTH,
    )
    left_y -= 10
    figure_height = 102
    draw_immutable_figure(pdf, left_x, left_y - figure_height, COLUMN_WIDTH, figure_height)
    caption_y = left_y - figure_height - 17
    pdf.setFont("Times-Bold", 9.2)
    pdf.drawString(left_x + 30, caption_y, "Figure 1: Browser translation pipeline")
    left_y = caption_y - 25
    left_y = wrapped_text(
        pdf,
        "The browser stores recoverable project state locally. Translation requests contain only the selected text blocks and never include the user's secret in exported project packages.",
        left_x,
        left_y,
        COLUMN_WIDTH,
    )
    left_y -= 16
    pdf.setFont("Times-Bold", 11.5)
    pdf.drawString(left_x, left_y, "2 Layout Inheritance")
    wrapped_text(
        pdf,
        "Single-column regions remain single-column, and double-column regions remain double-column. Mixed papers are processed region by region, while the Chinese page count may extend naturally.",
        left_x,
        left_y - 20,
        COLUMN_WIDTH,
    )

    pdf.setFont("Times-Bold", 11.5)
    pdf.drawString(right_x, column_top, "3 Semantic Alignment")
    right_y = column_top - 20
    right_y = wrapped_text(
        pdf,
        "English and Chinese do not share identical grammar. The reader therefore uses stable semantic groups instead of pretending that every sentence has a strict one-to-one counterpart.",
        right_x,
        right_y,
        COLUMN_WIDTH,
    )
    right_y -= 16
    centered_formula = "latency = parse + translate + compile    (1)"
    pdf.setFont("Times-Italic", 9.6)
    formula_x = right_x + (COLUMN_WIDTH - stringWidth(centered_formula, "Times-Italic", 9.6)) / 2
    pdf.drawString(formula_x, right_y, centered_formula)
    right_y -= 28
    right_y = wrapped_text(
        pdf,
        "Equation (1) is an immutable object. Its variables, symbols, subscripts, and number must be preserved exactly, even when adjacent explanatory text is translated.",
        right_x,
        right_y,
        COLUMN_WIDTH,
    )
    right_y -= 16
    pdf.setFont("Times-Bold", 11.5)
    pdf.drawString(right_x, right_y, "4 Completion Criteria")
    right_y -= 20
    right_y = wrapped_text(
        pdf,
        "A run is complete only after translation validation, deterministic composition, PDF compilation, alignment geometry resolution, and final quality checks all succeed.",
        right_x,
        right_y,
        COLUMN_WIDTH,
    )
    right_y -= 16
    pdf.setFont("Times-Bold", 11.5)
    pdf.drawString(right_x, right_y, "References")
    wrapped_text(
        pdf,
        "[1] A. Example and B. Example, Reliable Browser Document Processing, 2026.",
        right_x,
        right_y - 20,
        COLUMN_WIDTH,
        "Times-Roman",
        8.8,
        11.5,
    )

    pdf.setFont("Times-Roman", 8)
    pdf.drawCentredString(PAGE_WIDTH / 2, 28, "1")
    pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    build()
