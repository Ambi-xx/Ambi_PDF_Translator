/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect, useRef, ChangeEvent } from 'react';
import { 
  FileUp, 
  ChevronLeft, 
  ChevronRight, 
  Download, 
  Sparkles, 
  Loader2, 
  CheckCircle2, 
  Search,
  Type,
  Layout,
  MessageSquare,
  Pipette,
  Palette,
  Trash2,
  Merge,
  Scissors,
  Move,
  Save,
  RotateCcw,
  History
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as pdfjs from 'pdfjs-dist';

import { PageData, PdfData, TextBlock } from './types/pdf';
import { extractPdfData, extractPdfDataFromDoc, generateTranslatedPdf } from './lib/pdf-utils';
import { translateBatch } from './services/translate';

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Components ---

const PageThumbnail: React.FC<{ 
  buffer: ArrayBuffer; 
  pageIndex: number; 
  selected: boolean;
  onClick: () => void;
}> = ({ buffer, pageIndex, selected, onClick }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let active = true;
    const render = async () => {
      try {
        const loadingTask = pdfjs.getDocument({ data: buffer.slice(0) });
        const pdf = await loadingTask.promise;
        if (!active) return;
        const page = await pdf.getPage(pageIndex + 1);
        if (!active) return;

        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = canvasRef.current;
        if (!canvas) return;

        canvas.height = viewport.height;
        canvas.width = viewport.width;
        const context = canvas.getContext('2d');
        if (!context) return;

        await page.render({ canvasContext: context, viewport } as any).promise;
      } catch (e) {
        // Silently fail for thumbnails as it's just a preview
      }
    };
    render();
    return () => { active = false; };
  }, [buffer, pageIndex]);

  return (
    <button
      onClick={onClick}
      className={cn(
        "aspect-[3/4] rounded-xl border-2 flex flex-col items-center justify-center gap-2 transition-all relative overflow-hidden group",
        selected 
          ? "bg-indigo-50 border-indigo-600 shadow-lg shadow-indigo-100" 
          : "bg-white border-slate-200 opacity-60 grayscale hover:opacity-100 hover:grayscale-0 shadow-sm"
      )}
    >
      <canvas ref={canvasRef} className="w-full h-full object-cover" />
      {selected && (
        <div className="absolute top-2 right-2 text-indigo-600 bg-white rounded-full p-0.5 shadow-sm z-10">
          <CheckCircle2 size={16} />
        </div>
      )}
      <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 bg-slate-900/80 text-white text-[9px] font-bold px-2 py-0.5 rounded-full backdrop-blur-md opacity-0 group-hover:opacity-100 transition-opacity z-10">
        第 {pageIndex + 1} 页
      </div>
    </button>
  );
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfDocument, setPdfDocument] = useState<any>(null);
  const [pdfData, setPdfData] = useState<PdfData | null>(null);
  const [originalBuffer, setOriginalBuffer] = useState<ArrayBuffer | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);

  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [dragInfo, setDragInfo] = useState<{
    type: 'move' | 'resize-ne' | 'resize-nw' | 'resize-se' | 'resize-sw' | 'resize-n' | 'resize-s' | 'resize-e' | 'resize-w';
    startX: number;
    startY: number;
    initialBBox: { x: number; y: number; width: number; height: number };
  } | null>(null);

  const [showLoadPrompt, setShowLoadPrompt] = useState(false);
  const [savedDataToLoad, setSavedDataToLoad] = useState<PdfData | null>(null);

  const saveProgress = () => {
    if (!pdfData) return;
    try {
      const storageKey = `pdf_trans_v1_${pdfData.name}`;
      localStorage.setItem(storageKey, JSON.stringify(pdfData));
      alert("进度已保存到本地存储");
    } catch (e) {
      console.error("Save failed", e);
      alert("保存失败：可能是文件内容过多超出了浏览器存储限制");
    }
  };

  const loadProgressFromData = (data: PdfData) => {
    setPdfData(data);
    setShowLoadPrompt(false);
    setSavedDataToLoad(null);
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRenderTask = useRef<any>(null);

  // --- Handlers ---

  useEffect(() => {
    if (selectedBlockId) {
      const element = document.getElementById(`block-editor-${selectedBlockId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [selectedBlockId]);

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!pdfData || !canvasRef.current || isSelectionMode) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const currentPageData = pdfData.pages[currentPage];
    const scale = canvas.width / currentPageData.width;

    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

    // Helper: Convert canvas coords to PDF coords
    // PDF Y starts from bottom, Canvas Y starts from top
    const pdfY = (canvas.height - mouseY) / scale;
    const pdfX = mouseX / scale;

    // Check if clicked on resize handles of selected block
    if (selectedBlockId) {
      const block = currentPageData.blocks.find(b => b.id === selectedBlockId);
      if (block) {
        const { x, y, width, height } = block.bbox;
        const handleSize = 8 / scale;
        
        // Define handle regions
        const handles = [
          { type: 'resize-nw', x, y: y + height },
          { type: 'resize-ne', x: x + width, y: y + height },
          { type: 'resize-sw', x, y },
          { type: 'resize-se', x: x + width, y },
          { type: 'resize-n', x: x + width/2, y: y + height },
          { type: 'resize-s', x: x + width/2, y },
          { type: 'resize-e', x: x + width, y: y + height/2 },
          { type: 'resize-w', x, y: y + height/2 },
        ] as const;

        for (const h of handles) {
          if (Math.abs(pdfX - h.x) < handleSize && Math.abs(pdfY - h.y) < handleSize) {
            setDragInfo({
              type: h.type,
              startX: pdfX,
              startY: pdfY,
              initialBBox: { ...block.bbox }
            });
            return;
          }
        }
      }
    }

    // Check if clicked inside any block
    for (const block of currentPageData.blocks) {
      const { x, y, width, height } = block.bbox;
      if (pdfX >= x && pdfX <= x + width && pdfY >= y && pdfY <= y + height) {
        setSelectedBlockId(block.id);
        setDragInfo({
          type: 'move',
          startX: pdfX,
          startY: pdfY,
          initialBBox: { ...block.bbox }
        });
        return;
      }
    }

    setSelectedBlockId(null);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragInfo || !canvasRef.current || !pdfData || !selectedBlockId) return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const currentPageData = pdfData.pages[currentPage];
    const scale = canvas.width / currentPageData.width;

    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);
    const pdfX = mouseX / scale;
    const pdfY = (canvas.height - mouseY) / scale;

    const dx = pdfX - dragInfo.startX;
    const dy = pdfY - dragInfo.startY;

    const newBBox = { ...dragInfo.initialBBox };

    switch (dragInfo.type) {
      case 'move':
        newBBox.x += dx;
        newBBox.y += dy;
        break;
      case 'resize-ne':
        newBBox.width = Math.max(5, newBBox.width + dx);
        newBBox.height = Math.max(5, newBBox.height + dy);
        break;
      case 'resize-nw':
        newBBox.x += dx;
        newBBox.width = Math.max(5, newBBox.width - dx);
        newBBox.height = Math.max(5, newBBox.height + dy);
        break;
      case 'resize-se':
        newBBox.width = Math.max(5, newBBox.width + dx);
        newBBox.y += dy;
        newBBox.height = Math.max(5, newBBox.height - dy);
        break;
      case 'resize-sw':
        newBBox.x += dx;
        newBBox.width = Math.max(5, newBBox.width - dx);
        newBBox.y += dy;
        newBBox.height = Math.max(5, newBBox.height - dy);
        break;
      case 'resize-n':
        newBBox.height = Math.max(5, newBBox.height + dy);
        break;
      case 'resize-s':
        newBBox.y += dy;
        newBBox.height = Math.max(5, newBBox.height - dy);
        break;
      case 'resize-e':
        newBBox.width = Math.max(5, newBBox.width + dx);
        break;
      case 'resize-w':
        newBBox.x += dx;
        newBBox.width = Math.max(5, newBBox.width - dx);
        break;
    }

    // Update pdfData state
    const newData = { ...pdfData };
    const block = newData.pages[currentPage].blocks.find(b => b.id === selectedBlockId);
    if (block) {
      block.bbox = newBBox;
      setPdfData(newData);
    }
  };

  const handleCanvasMouseUp = () => {
    setDragInfo(null);
  };
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;

    setFile(uploadedFile);
    setIsProcessing(true);
    setProgress(0);

    try {
      const buffer = await uploadedFile.arrayBuffer();
      setOriginalBuffer(buffer);
      
      const loadingTask = pdfjs.getDocument({ data: buffer.slice(0) });
      const pdf = await loadingTask.promise;
      setPdfDocument(pdf);
      
      const storageKey = `pdf_trans_v1_${uploadedFile.name}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          const data = JSON.parse(saved);
          setSavedDataToLoad(data);
          setShowLoadPrompt(true);
        } catch (e) {}
      }

      const data = await extractPdfDataFromDoc(pdf, uploadedFile.name);
      if (!saved) {
        setPdfData(data);
        setCurrentPage(0);
      } else {
        // Even if saved exists, we set initial data for display while modal is open
        // But if we already set it above, we might overwrite.
        // Let's only set if pdfData is null or we are resetting.
        setPdfData(data);
      }
    } catch (err) {
      console.error("Upload error:", err);
      alert("Failed to process PDF. Please check the file and try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const translateSpecificPage = async (pageIdx: number) => {
    if (!pdfData) return;
    setIsProcessing(true);
    setProgress(0);

    const newData = { ...pdfData };
    const page = newData.pages[pageIdx];
    const untranslatedBlocks = page.blocks.filter(b => !b.zh);
    
    if (untranslatedBlocks.length > 0) {
      const texts = untranslatedBlocks.map(b => b.en);
      const translations = await translateBatch(texts);
      
      let tIdx = 0;
      page.blocks = page.blocks.map(b => {
          if (!b.zh) {
              return { ...b, zh: translations[tIdx++] || '' };
          }
          return b;
      });
      setPdfData({ ...newData });
    }
    setIsProcessing(false);
  };

  const togglePageSelection = (idx: number) => {
    if (!pdfData) return;
    const newData = { ...pdfData };
    newData.pages[idx].selected = !newData.pages[idx].selected;
    setPdfData(newData);
  };

  const selectAllPages = (selected: boolean) => {
    if (!pdfData) return;
    const newData = { ...pdfData };
    newData.pages = newData.pages.map(p => ({ ...p, selected }));
    setPdfData(newData);
  };

  const handleTranslateAll = async () => {
    if (!pdfData) return;
    setIsProcessing(true);
    setProgress(0);

    const selectedPagesIdx = pdfData.pages
      .map((p, i) => ({ selected: p.selected !== false, index: i }))
      .filter(p => p.selected)
      .map(p => p.index);
      
    const totalSelected = selectedPagesIdx.length;
    let processed = 0;
    const newData = { ...pdfData };

    // Process pages sequentially to avoid hitting rate limits too quickly
    for (const pageIdx of selectedPagesIdx) {
        const page = newData.pages[pageIdx];
        const untranslatedBlocks = page.blocks.filter(b => !b.zh);
        
        if (untranslatedBlocks.length > 0) {
            const texts = untranslatedBlocks.map(b => b.en);
            const translations = await translateBatch(texts);
            
            let tIdx = 0;
            page.blocks = page.blocks.map(b => {
                if (!b.zh) {
                    return { ...b, zh: translations[tIdx++] || '' };
                }
                return b;
            });
        }
        processed++;
        // Update overall progress
        setProgress(Math.round((processed / totalSelected) * 100));
        
        // Update state after each page to show progress
        setPdfData({ ...newData });
    }

    setIsProcessing(false);
  };

  const handleUpdateTranslation = (blockId: string, value: string) => {
    if (!pdfData) return;
    const newData = { ...pdfData };
    const page = newData.pages[currentPage];
    const blockIndex = page.blocks.findIndex(b => b.id === blockId);
    if (blockIndex !== -1) {
      page.blocks[blockIndex].zh = value;
      setPdfData(newData);
    }
  };

  const handleUpdateStyle = (blockId: string, updates: Partial<Pick<TextBlock, 'color' | 'fontSizeOverride'>>) => {
    if (!pdfData) return;
    const newData = { ...pdfData };
    const page = newData.pages[currentPage];
    const blockIndex = page.blocks.findIndex(b => b.id === blockId);
    if (blockIndex !== -1) {
      page.blocks[blockIndex] = { ...page.blocks[blockIndex], ...updates };
      setPdfData(newData);
    }
  };

  const handlePickColor = async (blockId: string) => {
    // @ts-ignore - EyeDropper API might not be in types yet
    if (!window.EyeDropper) {
      alert("Your browser does not support the EyeDropper API. Use the color picker.");
      return;
    }
    try {
      // @ts-ignore
      const eyeDropper = new window.EyeDropper();
      const result = await eyeDropper.open();
      handleUpdateStyle(blockId, { color: result.sRGBHex });
    } catch (e) {
      console.log("Eyedropper canceled");
    }
  };

  const translateSingleBlock = async (blockId: string) => {
    if (!pdfData) return;
    const page = pdfData.pages[currentPage];
    const block = page.blocks.find(b => b.id === blockId);
    if (!block) return;

    const [translation] = await translateBatch([block.en]);
    handleUpdateTranslation(blockId, translation || '');
  };

  const handleMergeWithNext = (blockId: string) => {
    if (!pdfData) return;
    const newData = { ...pdfData };
    const page = newData.pages[currentPage];
    const idx = page.blocks.findIndex(b => b.id === blockId);
    if (idx !== -1 && idx < page.blocks.length - 1) {
      const curr = page.blocks[idx];
      const next = page.blocks[idx + 1];
      
      // Combine text
      curr.en += " " + next.en;
      curr.zh += (curr.zh && next.zh) ? "\n" + next.zh : (curr.zh || next.zh || "");
      
      // Expand bbox
      const minX = Math.min(curr.bbox.x, next.bbox.x);
      const minY = Math.min(curr.bbox.y, next.bbox.y);
      const maxX = Math.max(curr.bbox.x + curr.bbox.width, next.bbox.x + next.bbox.width);
      const maxY = Math.max(curr.bbox.y + curr.bbox.height, next.bbox.y + next.bbox.height);
      
      curr.bbox = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      };
      
      page.blocks.splice(idx + 1, 1);
      setPdfData({ ...newData });
    }
  };

  const handleDeleteBlock = (blockId: string) => {
    if (!pdfData) return;
    const newData = { ...pdfData };
    const page = newData.pages[currentPage];
    page.blocks = page.blocks.filter(b => b.id !== blockId);
    setPdfData({ ...newData });
  };

  const handleUpdateBBox = (blockId: string, field: keyof TextBlock['bbox'], value: number) => {
    if (!pdfData) return;
    const newData = { ...pdfData };
    const page = newData.pages[currentPage];
    const block = page.blocks.find(b => b.id === blockId);
    if (block) {
      block.bbox[field] = value;
      setPdfData({ ...newData });
    }
  };

  const handleExport = async () => {
    if (!pdfData || !originalBuffer) return;
    setIsGenerating(true);
    try {
      // Use a copy to prevent detachment issues
      const pdfCopy = originalBuffer.slice(0);
      const uint8Array = await generateTranslatedPdf(pdfCopy, pdfData.pages);
      const blob = new Blob([uint8Array], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Translated_${pdfData.name}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export error:", err);
      alert("Failed to generate PDF.");
    } finally {
      setIsGenerating(false);
    }
  };

  // Separated drawing logic for performance
  const drawOverlays = useCallback(() => {
    const canvas = canvasRef.current;
    const backingCanvas = backingCanvasRef.current;
    if (!canvas || !backingCanvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    // 1. Restore background from backing canvas
    context.drawImage(backingCanvas, 0, 0);

    if (!pdfData) return;

    const currentPageData = pdfData.pages[currentPage];
    if (!currentPageData) return;

    const scale = canvas.width / currentPageData.width;

    // Draw Overlays
    context.setLineDash([5, 5]);
    context.lineWidth = 1;
    
    for (const block of currentPageData.blocks) {
      const { x, y, width, height } = block.bbox;
      const scaledX = x * scale;
      const scaledY = canvas.height - (y * scale);
      const scaledW = width * scale;
      const scaledH = height * scale;

      const isHovered = hoveredBlockId === block.id;
      const isSelected = selectedBlockId === block.id;

      // Draw discovery box
      const blockIdx = currentPageData.blocks.indexOf(block) + 1;
      context.strokeStyle = isSelected ? '#4F46E5' : (isHovered ? 'rgba(79, 70, 229, 1)' : 'rgba(148, 163, 184, 0.4)');
      context.lineWidth = (isHovered || isSelected) ? 2 : 1;
      
      if (isHovered || isSelected) {
        context.setLineDash([]);
        context.strokeRect(scaledX - 2, scaledY - scaledH - 2, scaledW + 4, scaledH + 4);
        context.fillStyle = isSelected ? 'rgba(79, 70, 229, 0.15)' : 'rgba(79, 70, 229, 0.1)';
        context.fillRect(scaledX - 2, scaledY - scaledH - 2, scaledW + 4, scaledH + 4);
        
        // Draw Label tag
        const label = `BLOCK ${blockIdx}`;
        context.font = 'bold 10px sans-serif';
        const labelMetrics = context.measureText(label);
        context.fillStyle = isSelected ? '#4F46E5' : 'rgba(79, 70, 229, 1)';
        context.fillRect(scaledX - 2, scaledY - scaledH - 16, labelMetrics.width + 8, 14);
        context.fillStyle = 'white';
        context.textBaseline = 'top';
        context.fillText(label, scaledX + 2, scaledY - scaledH - 14);

        // Draw selection handles
        if (isSelected) {
          context.fillStyle = '#4F46E5';
          const hSize = 6;
          // Corners
          context.fillRect(scaledX - hSize/2 - 2, scaledY - scaledH - hSize/2 - 2, hSize, hSize); // TL
          context.fillRect(scaledX + scaledW - hSize/2 + 2, scaledY - scaledH - hSize/2 - 2, hSize, hSize); // TR
          context.fillRect(scaledX - hSize/2 - 2, scaledY - hSize/2 + 2, hSize, hSize); // BL
          context.fillRect(scaledX + scaledW - hSize/2 + 2, scaledY - hSize/2 + 2, hSize, hSize); // BR
          // Midpoints
          context.fillRect(scaledX + scaledW/2 - hSize/2, scaledY - scaledH - hSize/2 - 2, hSize, hSize); // T
          context.fillRect(scaledX + scaledW/2 - hSize/2, scaledY - hSize/2 + 2, hSize, hSize); // B
          context.fillRect(scaledX - hSize/2 - 2, scaledY - scaledH/2 - hSize/2, hSize, hSize); // L
          context.fillRect(scaledX + scaledW - hSize/2 + 2, scaledY - scaledH/2 - hSize/2, hSize, hSize); // R
        }
      } else {
        context.setLineDash([4, 4]);
        context.strokeRect(scaledX, scaledY - scaledH, scaledW, scaledH);
      }

      if (!block.zh) continue;
      
      const fontSize = (block.fontSizeOverride || block.fontSize) * scale;

      // Sample background color (from backing canvas to be pure)
      const backingContext = backingCanvas.getContext('2d');
      if (backingContext) {
        try {
          const sampleX = Math.max(0, Math.min(backingCanvas.width - 1, scaledX));
          const sampleY = Math.max(0, Math.min(backingCanvas.height - 1, scaledY - scaledH / 2));
          const pixel = backingContext.getImageData(sampleX, sampleY, 1, 1).data;
          context.fillStyle = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
        } catch (e) {
          context.fillStyle = 'white';
        }
      } else {
        context.fillStyle = 'white';
      }

      // Fill background
      context.fillRect(scaledX, scaledY - scaledH, scaledW, scaledH);

      // Draw text
      context.fillStyle = block.color || 'black';
      context.font = `${fontSize * 0.85}px sans-serif`;
      context.textBaseline = 'top';
      
      const chars = block.zh.split('');
      let line = '';
      let currentY = scaledY - scaledH + (fontSize * 0.08);
      const maxWidth = scaledW;

      for (let n = 0; n < chars.length; n++) {
        const testLine = line + chars[n];
        const metrics = context.measureText(testLine);
        if (metrics.width > maxWidth && n > 0) {
          context.fillText(line, scaledX, currentY);
          line = chars[n];
          currentY += fontSize * 1.1;
        } else {
          line = testLine;
        }
      }
      context.fillText(line, scaledX, currentY);
    }
    context.setLineDash([]);
  }, [pdfData, currentPage, hoveredBlockId, selectedBlockId]);

  const renderPageSnapshot = useCallback(async () => {
    if (!originalBuffer || !canvasRef.current) return;

    if (activeRenderTask.current) {
      try {
        await activeRenderTask.current.cancel();
      } catch (e) {}
    }

    try {
      let pdf = pdfDocument;
      if (!pdf) {
        const loadingTask = pdfjs.getDocument({ data: originalBuffer.slice(0) });
        pdf = await loadingTask.promise;
        setPdfDocument(pdf);
      }
      
      const page = await pdf.getPage(currentPage + 1);
      const scale = 2.5; 
      const viewport = page.getViewport({ scale });
      
      // Setup backing canvas
      const backingCanvas = document.createElement('canvas');
      backingCanvas.height = viewport.height;
      backingCanvas.width = viewport.width;
      const backingContext = backingCanvas.getContext('2d', { willReadFrequently: true });
      
      if (!backingContext) return;
      
      const renderTask = page.render({
        canvasContext: backingContext,
        viewport: viewport,
      } as any);
      activeRenderTask.current = renderTask;

      try {
        await renderTask.promise;
        backingCanvasRef.current = backingCanvas;
        
        // Update main canvas size
        const canvas = canvasRef.current;
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        drawOverlays();
      } catch (err: any) {
        if (err.name === 'RenderingCancelledException') return;
        console.error("Render task error:", err);
      } finally {
        if (activeRenderTask.current === renderTask) {
          activeRenderTask.current = null;
        }
      }
    } catch (err) {
      console.error("Render snapshot error:", err);
    }
  }, [originalBuffer, currentPage, pdfDocument, drawOverlays]);

  useEffect(() => {
    if (originalBuffer) {
      renderPageSnapshot();
    }
  }, [originalBuffer, currentPage]);

  // Only trigger overlay draw on data changes (fast)
  useEffect(() => {
    if (backingCanvasRef.current) {
      drawOverlays();
    }
  }, [pdfData, hoveredBlockId, drawOverlays]);

  // Filter blocks by search
  const currentBlocks = pdfData?.pages[currentPage]?.blocks || [];
  const filteredBlocks = currentBlocks.filter(b => 
    b.en.toLowerCase().includes(searchTerm.toLowerCase()) || 
    b.zh.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#F0F2F5] text-slate-900 font-sans selection:bg-indigo-100">
      {/* Top Banner / Navigation */}
      <header className="fixed top-0 left-0 right-0 h-16 bg-white/80 backdrop-blur-md border-b border-slate-200 z-50 px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
            <Layout size={20} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-800">PDF Translation Expert</h1>
            <p className="text-[10px] uppercase tracking-widest font-semibold text-slate-400">Layout Preserved • AI Powered</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {pdfData && (
            <>
              <div className="bg-slate-100 rounded-full px-3 py-1.5 gap-2 border border-slate-200">
                <button 
                  onClick={() => setCurrentPage(prev => Math.max(0, prev - 1))}
                  disabled={currentPage === 0}
                  className="p-1 hover:bg-white rounded-full disabled:opacity-30 transition-all"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-xs font-mono font-medium min-w-[80px] text-center uppercase">
                  第 {currentPage + 1} 页 / 共 {pdfData.pages.length} 页
                </span>
                <button 
                  onClick={() => setCurrentPage(prev => Math.min(pdfData.pages.length - 1, prev + 1))}
                  disabled={currentPage === pdfData.pages.length - 1}
                  className="p-1 hover:bg-white rounded-full disabled:opacity-30 transition-all"
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              <button 
                onClick={saveProgress}
                className="flex items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 px-4 py-2 rounded-full text-sm font-semibold transition-all shadow-sm active:scale-95"
              >
                <Save size={18} />
                保存进度
              </button>
              <button
                onClick={handleExport}
                disabled={isGenerating}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-full text-sm font-semibold transition-all shadow-md active:scale-95 disabled:bg-slate-400"
              >
                {isGenerating ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />}
                导出 PDF
              </button>
            </>
          )}
        </div>
      </header>      <main className="pt-16 pb-2 px-6 max-w-[1440px] mx-auto flex gap-4 h-[calc(100vh-100px)]">
        {!pdfData ? (
          <div className="w-full flex flex-col items-center justify-center bg-white rounded-3xl border-2 border-dashed border-slate-200 p-8 transition-all hover:border-indigo-300">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-500 mb-4"
            >
              <FileUp size={32} />
            </motion.div>
            <h2 className="text-lg font-bold text-slate-800 mb-1">专业 PDF AI 翻译</h2>
            <p className="text-slate-500 mb-6 max-w-xs text-center text-xs">
              上传 PDF 文档，我们将为您提取文本并生成保留原始布局的翻译。
            </p>
            
            <label className="cursor-pointer group">
              <input type="file" accept=".pdf" onChange={handleFileUpload} className="hidden" />
              <div className="bg-white border-2 border-slate-900 px-6 py-2.5 rounded-xl font-bold text-slate-900 group-hover:bg-slate-900 group-hover:text-white transition-all shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none text-sm">
                {isProcessing ? "处理中..." : "选择 PDF 文件"}
              </div>
            </label>
          </div>
        ) : (
          <div className="flex-1 flex gap-4 overflow-hidden">
            {/* Left: Original Reference */}
            <div className="flex-[3] flex flex-col bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
              <div className="p-2.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-2 text-slate-400">
                  <Layout size={12} />
                  <span className="text-[9px] font-bold uppercase tracking-wider">文档预览</span>
                </div>
                <div className="px-2 py-1 bg-white rounded border border-slate-200 text-[10px] font-mono text-slate-400">
                  CTRL + 滚轮缩放
                </div>
                <button 
                  onClick={() => setIsSelectionMode(!isSelectionMode)}
                  className={cn(
                    "text-[9px] font-bold uppercase px-3 py-1 rounded-md transition-all",
                    isSelectionMode ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-500"
                  )}
                >
                  {isSelectionMode ? "退出页面选择" : "选择页面"}
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4 bg-slate-50 flex flex-wrap justify-center items-start gap-4 custom-scrollbar">
                {isSelectionMode ? (
                  <div className="w-full grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4 p-4">
                    <button 
                      onClick={() => selectAllPages(true)}
                      className="col-span-full mb-2 bg-white border border-slate-200 py-2 rounded-xl text-[10px] font-bold uppercase hover:bg-slate-50"
                    >
                      Select All Pages
                    </button>
                    {pdfData.pages.map((p, idx) => (
                      <PageThumbnail
                        key={idx}
                        buffer={originalBuffer!}
                        pageIndex={idx}
                        selected={p.selected !== false}
                        onClick={() => togglePageSelection(idx)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="bg-white shadow-xl relative m-auto">
                    <canvas 
                      ref={canvasRef} 
                      onMouseDown={handleCanvasMouseDown}
                      onMouseMove={handleCanvasMouseMove}
                      onMouseUp={handleCanvasMouseUp}
                      onMouseLeave={handleCanvasMouseUp}
                      className={cn(
                        "max-w-full h-auto",
                        dragInfo ? "cursor-grabbing" : (selectedBlockId ? "cursor-default" : "cursor-crosshair")
                      )}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Right: Translation Editor */}
            <div className="w-[360px] flex flex-col bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="p-3.5 border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-slate-400">
                    <MessageSquare size={12} />
                    <span className="text-[9px] font-bold uppercase tracking-wider">编辑器面板</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button 
                      onClick={() => translateSpecificPage(currentPage)}
                      disabled={isProcessing}
                      className="text-[9px] font-bold uppercase bg-amber-500 text-white px-2.5 py-1 rounded-md hover:bg-amber-600 transition-colors shadow-sm disabled:opacity-50"
                    >
                      {isProcessing ? "..." : "翻译本页"}
                    </button>
                    <button 
                      onClick={handleTranslateAll}
                      disabled={isProcessing}
                      className="text-[9px] font-bold uppercase bg-slate-800 text-white px-2.5 py-1 rounded-md hover:bg-slate-900 transition-colors shadow-sm disabled:opacity-50"
                    >
                      全部翻译
                    </button>
                  </div>
                </div>

                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={12} />
                  <input 
                    type="text"
                    placeholder="Search identified text..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg pl-8 pr-3 py-1.5 text-xs focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-400 transition-all outline-none"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-slate-50/30">
                <AnimatePresence mode="popLayout">
                  {filteredBlocks.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-300 py-10">
                      <Search size={20} className="mb-2 opacity-50" />
                      <p className="text-[10px] font-bold uppercase tracking-wider">无相关内容</p>
                    </div>
                  ) : (
                    filteredBlocks.map((block, idx) => (
                      <motion.div 
                        key={block.id}
                        id={`block-editor-${block.id}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1, backgroundColor: selectedBlockId === block.id ? 'rgba(79, 70, 229, 0.05)' : 'rgba(255, 255, 255, 0)' }}
                        onMouseEnter={() => setHoveredBlockId(block.id)}
                        onMouseLeave={() => setHoveredBlockId(null)}
                        onClick={() => setSelectedBlockId(block.id)}
                        className={cn(
                          "p-2 rounded-xl border border-transparent transition-all space-y-1.5",
                          selectedBlockId === block.id && "border-indigo-200 shadow-sm ring-1 ring-indigo-100"
                        )}
                      >
                         <div className="text-[8px] font-bold text-slate-400 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                               <span>文本块 {idx + 1}</span>
                               <span className="opacity-50">•</span>
                               <span>{Math.round(block.fontSize)}PT • {block.fontName.split('+').pop()}</span>
                            </div>
                            <div className="flex items-center gap-1">
                                <button 
                                  onClick={() => handleMergeWithNext(block.id)}
                                  className="p-1 hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 rounded transition-colors"
                                  title="合并到下一块"
                                >
                                  <Merge size={10} />
                                </button>
                                <button 
                                  onClick={() => handleDeleteBlock(block.id)}
                                  className="p-1 hover:bg-red-50 text-slate-400 hover:text-red-600 rounded transition-colors"
                                  title="删除此块"
                                >
                                  <Trash2 size={10} />
                                </button>
                                <button 
                                  onClick={() => translateSingleBlock(block.id)}
                                  className="text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors px-1.5 py-0.5 rounded hover:bg-indigo-50"
                                >
                                  <Sparkles size={8} />
                                  <span>自动翻译</span>
                                </button>
                            </div>
                         </div>
                        <div className="p-2.5 rounded-xl bg-white border border-slate-200 shadow-sm hover:border-indigo-200 transition-all group">
                          <p className="text-[10px] text-slate-400 mb-2 leading-relaxed line-clamp-2 group-hover:line-clamp-none transition-all">
                            {block.en}
                          </p>
                          <textarea
                            value={block.zh}
                            onFocus={() => setHoveredBlockId(block.id)}
                            onBlur={() => setHoveredBlockId(null)}
                            onChange={(e) => handleUpdateTranslation(block.id, e.target.value)}
                            placeholder="等待翻译..."
                            className="w-full bg-slate-50 border border-slate-100 rounded-lg p-2 text-xs focus:bg-white focus:ring-4 focus:ring-indigo-50/50 focus:border-indigo-400 transition-all outline-none resize-none min-h-[50px] font-medium mb-2"
                            style={{ color: block.color || 'inherit' }}
                          />
                          
                          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                             <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md">
                                <Palette size={10} className="text-slate-400" />
                                <input 
                                  type="color" 
                                  value={block.color || '#000000'}
                                  onChange={(e) => handleUpdateStyle(block.id, { color: e.target.value })}
                                  className="w-4 h-4 rounded-full border-0 p-0 overflow-hidden cursor-pointer bg-transparent"
                                />
                                <button 
                                  onClick={() => handlePickColor(block.id)}
                                  className="text-[9px] font-bold text-slate-400 hover:text-indigo-600 transition-colors"
                                  title="从屏幕取色"
                                >
                                  <Pipette size={10} />
                                </button>
                             </div>

                             <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md">
                                <Type size={10} className="text-slate-400" />
                                <input 
                                  type="number"
                                  min="6"
                                  max="72"
                                  value={Math.round(block.fontSizeOverride || block.fontSize)}
                                  onChange={(e) => handleUpdateStyle(block.id, { fontSizeOverride: parseInt(e.target.value) })}
                                  className="w-8 bg-transparent text-[10px] font-bold outline-none"
                                />
                                <span className="text-[8px] font-bold text-slate-300 uppercase">PX</span>
                             </div>

                             {/* BBox Adjustment */}
                             <div className="flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md">
                                <Move size={10} className="text-slate-400" />
                                <div className="flex gap-1.5 text-[8px] font-bold text-slate-400">
                                   <div className="flex items-center gap-0.5">
                                      <span>X</span>
                                      <input 
                                        type="number" 
                                        value={Math.round(block.bbox.x)} 
                                        onChange={(e) => handleUpdateBBox(block.id, 'x', parseInt(e.target.value))}
                                        className="w-7 bg-transparent text-slate-600 outline-none"
                                      />
                                   </div>
                                   <div className="flex items-center gap-0.5">
                                      <span>Y</span>
                                      <input 
                                        type="number" 
                                        value={Math.round(block.bbox.y)} 
                                        onChange={(e) => handleUpdateBBox(block.id, 'y', parseInt(e.target.value))}
                                        className="w-7 bg-transparent text-slate-600 outline-none"
                                      />
                                   </div>
                                   <div className="flex items-center gap-0.5">
                                      <span>W</span>
                                      <input 
                                        type="number" 
                                        value={Math.round(block.bbox.width)} 
                                        onChange={(e) => handleUpdateBBox(block.id, 'width', parseInt(e.target.value))}
                                        className="w-7 bg-transparent text-slate-600 outline-none"
                                      />
                                   </div>
                                   <div className="flex items-center gap-0.5">
                                      <span>H</span>
                                      <input 
                                        type="number" 
                                        value={Math.round(block.bbox.height)} 
                                        onChange={(e) => handleUpdateBBox(block.id, 'height', parseInt(e.target.value))}
                                        className="w-7 bg-transparent text-slate-600 outline-none"
                                      />
                                   </div>
                                </div>
                             </div>
                          </div>
                        </div>
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Processing Portal */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[100] flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl flex flex-col items-center text-center"
            >
              <div className="relative w-20 h-20 mb-6">
                <svg className="w-full h-full -rotate-90">
                  <circle 
                    cx="40" cy="40" r="36" 
                    fill="none" stroke="#F1F5F9" strokeWidth="8"
                  />
                  <motion.circle 
                    cx="40" cy="40" r="36" 
                    fill="none" stroke="#4F46E5" strokeWidth="8"
                    strokeDasharray="226.19"
                    initial={{ strokeDashoffset: 226.19 }}
                    animate={{ strokeDashoffset: 226.19 * (1 - progress / 100) }}
                    className="transition-all duration-300"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center text-indigo-600 font-bold">
                  {progress}%
                </div>
              </div>
              <h3 className="text-lg font-bold text-slate-800 mb-2 font-display">AI 正在翻译...</h3>
              <p className="text-slate-500 text-sm mb-6">我们正在使用 Gemini 处理每一个文本块，以确保高准确度和上下文相关性。</p>
              <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    className="h-full bg-indigo-600" 
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Load Progress Prompt */}
      <AnimatePresence>
        {showLoadPrompt && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl border border-slate-100 flex flex-col items-center text-center"
            >
              <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mb-6">
                <History size={32} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-2 font-display">发现之前的进度</h3>
              <p className="text-slate-500 text-sm mb-8">检测到您之前翻译过此文件，是否恢复之前的翻译和布局调整？</p>
              
              <div className="grid grid-cols-2 gap-3 w-full">
                <button 
                  onClick={() => {
                    setShowLoadPrompt(false);
                    setSavedDataToLoad(null);
                    setCurrentPage(0);
                  }}
                  className="px-6 py-3 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50 transition-all"
                >
                  重新开始
                </button>
                <button 
                  onClick={() => {
                    if (savedDataToLoad) {
                      setPdfData(savedDataToLoad);
                      setCurrentPage(0);
                    }
                    setShowLoadPrompt(false);
                    setSavedDataToLoad(null);
                  }}
                  className="px-6 py-3 rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                >
                  恢复进度
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
        <div className="bg-slate-900 text-white px-5 py-2.5 rounded-full shadow-xl flex items-center gap-6 text-sm border border-slate-800/50 backdrop-blur-xl">
           <div className="flex items-center gap-2">
             <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
             <span className="font-medium opacity-80">Gemini 1.5 Flash 已连接</span>
           </div>
           <div className="w-px h-4 bg-slate-700" />
           <div className="flex items-center gap-2">
             <Layout className="text-indigo-400" size={14} />
             <span className="font-medium opacity-80 tracking-tight">布局还原技术 v1.1 - 支持手动调整</span>
           </div>
        </div>
      </footer>
    </div>
  );
}
