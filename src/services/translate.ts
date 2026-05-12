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
  
  const batchSize = 25;
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
    const maxAttempts = 3;

    while (!success && attempts < maxAttempts) {
        try {
          if (attempts > 0) {
            // Exponential backoff for retries
            await sleep(Math.pow(2, attempts) * 1000);
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
            console.warn("Batch size mismatch, retry attempt:", attempts + 1);
            attempts++;
          }
        } catch (error: any) {
          const errorMsg = error?.message || String(error);
          console.error("Batch translation error:", errorMsg);
          
          // Check for 429 Rate Limit
          if (errorMsg.includes("429") || error?.status === 429) {
            console.log("Rate limit hit (429), slowing down and waiting for retry...");
            attempts++;
            await sleep(2000 * attempts); // Manual wait before next attempt
          } else {
            // Non-429 error, don't retry too many times
            console.warn("Non-429 error occurred, falling back to original text for this batch");
            results.push(...batch);
            success = true;
          }
        }
    }

    if (!success) {
      // If all retries failed, keep original text
      results.push(...batch);
    }
    
    // Add a mandatory delay between batches to stay under rate limits
    if (i + batchSize < texts.length) {
      await sleep(1000); 
    }
  }

  return results;
}
