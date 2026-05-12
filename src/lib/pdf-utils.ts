/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pdfjs from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { PDFDocument, rgb } from 'pdf-lib';
import { PageData, TextBlock } from '../types/pdf';
import fontkit from '@pdf-lib/fontkit';

// Initialize PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export async function extractPdfData(file: File): Promise<{ name: string; pages: PageData[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer.slice(0) });
  const pdf = await loadingTask.promise;
  return extractPdfDataFromDoc(pdf, file.name);
}

export async function extractPdfDataFromDoc(pdf: any, name: string): Promise<{ name: string; pages: PageData[] }> {
  const pagesData: PageData[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    
    // Heuristic: Check if this is a Table of Contents (TOC) page
    const allText = textContent.items.map((it: any) => it.str).join(' ').toUpperCase();
    const isTocPage = allText.includes('CONTENTS') || allText.includes('INDEX') || allText.includes('目录') || allText.includes('目次') || allText.includes('P. ') || allText.includes('PAGE ');

    // Sort items by Y (top to bottom) then X (left to right)
    const items = (textContent.items as any[]).filter(item => item.str.trim()).sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5];
      if (Math.abs(yDiff) > 5) return yDiff; // Different line
      return a.transform[4] - b.transform[4]; // Same line, order by X
    });

    const blocks: TextBlock[] = [];
    let currentBlock: TextBlock | null = null;

    items.forEach((item, idx) => {
      const x = item.transform[4];
      const y = item.transform[5];
      const fontSize = Math.sqrt(item.transform[0] * item.transform[0] + item.transform[1] * item.transform[1]);
      
      // Adjust constants for merging
      const isSameLine = currentBlock && Math.abs(currentBlock.bbox.y - y) < fontSize * 0.8;
      const horizontalGap = currentBlock ? x - (currentBlock.bbox.x + currentBlock.bbox.width) : 999;
      const verticalGap = currentBlock ? currentBlock.bbox.y - y : 999;
      
      let shouldMerge = false;
      if (currentBlock) {
        if (isSameLine) {
          // Normal horizontal merge
          shouldMerge = horizontalGap < fontSize * 6;
        } else if (!isTocPage) {
          // Paragraph merging for regular pages: 
          // 1. Vertical gap is small (typically next line in paragraph)
          // 2. Horizontal starting position is similar
          shouldMerge = verticalGap < fontSize * 2.5 && Math.abs(currentBlock.bbox.x - x) < fontSize * 5;
        }
      }

      if (shouldMerge && currentBlock) {
        currentBlock.en += (isSameLine ? "" : " ") + item.str;
        
        // Calculate new combined bounding box
        const minX = Math.min(currentBlock.bbox.x, x);
        const maxX = Math.max(currentBlock.bbox.x + currentBlock.bbox.width, x + item.width);
        const maxY = Math.max(currentBlock.bbox.y, y);
        
        currentBlock.bbox = {
          x: minX,
          y: y, // Using the lowest Y for the reference point
          width: maxX - minX,
          height: (currentBlock.bbox.y + currentBlock.bbox.height) - y,
        };
      } else {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = {
          id: `p${i}-b${idx}`,
          en: item.str,
          zh: '',
          bbox: {
            x: x,
            y: y,
            width: item.width,
            height: item.height || fontSize,
          },
          fontSize: fontSize,
          fontName: item.fontName,
        };
      }
    });

    if (currentBlock) blocks.push(currentBlock);

    pagesData.push({
      pageNumber: i,
      width: viewport.width,
      height: viewport.height,
      blocks: blocks,
    });
  }

  return { name: name, pages: pagesData };
}

// Utility to convert hex to RGB
function hexToRgb(hex?: string) {
  if (!hex) return rgb(0, 0, 0); // Default to black
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
}

export async function generateTranslatedPdf(
  originalBuffer: ArrayBuffer,
  translatedPages: PageData[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalBuffer);
  pdfDoc.registerFontkit(fontkit);

  // Load a Chinese font (Noto Sans SC)
  // This is a simplified URL. In production, you'd host this or a subsetted version.
  const FONT_URL = "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/Variable/TTF/NotoSansCJKsc-VF.ttf";
  let font;
  try {
    const fontBytes = await fetch(FONT_URL).then(res => {
        if (!res.ok) throw new Error("Failed to load font");
        return res.arrayBuffer();
    });
    font = await pdfDoc.embedFont(fontBytes);
  } catch (e) {
    console.error("Font loading error:", e);
    // Fallback to standard font (won't support CJK well but prevents crash)
    font = await pdfDoc.embedFont('Helvetica');
  }

  const pages = pdfDoc.getPages();

  for (let i = 0; i < translatedPages.length; i++) {
    const pageData = translatedPages[i];
    const page = pages[i];
    const { height } = page.getSize();

    for (const block of pageData.blocks) {
      if (!block.zh) continue;

      // Draw original background color or just cover text
      // In the Streamlit version, they sample the background. 
      // Here we'll just draw a white rectangle to white-out the original text.
      // (Optional: improve by sampling pixel color if possible)
      page.drawRectangle({
        x: block.bbox.x,
        y: block.bbox.y - 2, // Slight offset for baseline
        width: block.bbox.width + 4,
        height: block.bbox.height + 4,
        color: rgb(1, 1, 1), // White
      });

      const drawFontSize = block.fontSizeOverride || block.fontSize;

      // Insert translated text with wrapping
      page.drawText(block.zh, {
        x: block.bbox.x,
        y: block.bbox.y + drawFontSize - 2, // Start from top of block
        size: drawFontSize * 0.9,
        font: font,
        color: hexToRgb(block.color),
        maxWidth: block.bbox.width,
        lineHeight: drawFontSize * 1.2,
      });
    }
  }

  return await pdfDoc.save();
}
