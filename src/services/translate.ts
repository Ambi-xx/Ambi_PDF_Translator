/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export async function translateText(text: string): Promise<string> {
  if (!text.trim()) return '';
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Translate the following English text to Chinese (Simplified). Return ONLY the translated text without any explanations or extra characters: \n\n${text}`,
      config: {
        temperature: 0.1, // Keep it precise
      }
    });

    return response.text?.trim() || text;
  } catch (error) {
    console.error("Translation error:", error);
    return text; // Fallback to original
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function translateBatch(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  
  // Larger batch size to reduce total request count
  const batchSize = 45;
  const results: string[] = [];
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const prompt = `Translate each of the following ${batch.length} English segments to Chinese (Simplified). 
Return the translations as a JSON array of strings. 
CRITICAL: Return EXACTLY ${batch.length} strings in the array.
Example Input: ["Hello", "World"] 
Example Output: ["你好", "世界"]

Input Segments: ${JSON.stringify(batch)}`;

    let success = false;
    let attempts = 0;
    const maxAttempts = 4;

    while (!success && attempts < maxAttempts) {
        try {
          if (attempts > 0) {
            // More aggressive backoff: 5s, 10s, 20s...
            const backoffTime = Math.pow(2, attempts) * 3000;
            console.log(`Rate limit backoff: Waiting ${backoffTime}ms...`);
            await sleep(backoffTime);
          }

          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              temperature: 0.1,
            }
          });

          const jsonText = response.text || "[]";
          const translatedBatch = JSON.parse(jsonText);
          
          if (Array.isArray(translatedBatch) && translatedBatch.length === batch.length) {
            results.push(...translatedBatch);
            success = true;
          } else {
            console.warn(`Batch mismatch (expected ${batch.length}, got ${translatedBatch.length}). Retry ${attempts + 1}`);
            attempts++;
          }
        } catch (error: any) {
          const errorMsg = error?.message || String(error);
          
          if (errorMsg.includes("429") || error?.status === 429) {
            console.warn("Gemini Rate Limit (429) encountered. Increasing delay...");
            attempts++;
            await sleep(5000 * attempts); 
          } else {
            console.error("Translation batch error:", errorMsg);
            attempts++;
            if (attempts >= maxAttempts) {
              results.push(...batch);
              success = true;
            }
          }
        }
    }

    if (!success) {
      results.push(...batch);
    }
    
    // Safety delay between batches to stay under free tier RPM limits
    if (i + batchSize < texts.length) {
      await sleep(4500); 
    }
  }

  return results;
}
