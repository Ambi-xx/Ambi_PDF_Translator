/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TextBlock {
  id: string;
  en: string;
  zh: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  fontSize: number;
  fontName: string;
  color?: string;
  fontSizeOverride?: number;
}

export interface PageData {
  pageNumber: number;
  width: number;
  height: number;
  blocks: TextBlock[];
  selected?: boolean;
}

export interface PdfData {
  name: string;
  pages: PageData[];
}
