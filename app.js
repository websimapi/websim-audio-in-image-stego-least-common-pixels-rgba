import { embedAudioInImage, extractAudioFromImage, maskToImageData } from "./stego.js";

/* state */
let origImgData = null;
let stegoImgData = null;
let maskUint8 = null;
let audioArrayBuffer = null;
let lastExtractedOk = false;

/* elements */
const imgInput = document.getElementById("imageInput");
const audioInput = document.getElementById("audioInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const embedBtn = document.getElementById("embedBtn");
const extractBtn = document.getElementById("extractBtn");
const downloadStegoBtn = document.getElementById("downloadStegoBtn");
const rescaleBtn = document.getElementById("rescaleBtn");
const downloadMaskBtn = document.getElementById("downloadMaskBtn");
const genAiTextBtn = document.getElementById("genAiTextBtn");
const polishAiTextBtn = document.getElementById("polishAiTextBtn");
const stats = document.getElementById("stats");

const origCanvas = document.getElementById("origCanvas");
const stegoCanvas = document.getElementById("stegoCanvas");
const maskCanvas = document.getElementById("maskCanvas");
const aiText = document.getElementById("aiText");

/* helpers */
function drawImageToCanvas(imgBlob, canvas) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(imgBlob);
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}

function setStats(text) { stats.textContent = text; }

function requiredBits() {
  if (!audioArrayBuffer) return 0;
  return (16 + new Uint8Array(audioArrayBuffer).length) * 8;
}

function imageCapacityBits() {
  return origImgData ? origImgData.width * origImgData.height * 4 : 0; // RGBA LSBs
}

function enableControls() {
  analyzeBtn.disabled = !origImgData;
  embedBtn.disabled = !(origImgData && audioArrayBuffer);
  rescaleBtn.disabled = !(origImgData && audioArrayBuffer && imageCapacityBits() < requiredBits());
  extractBtn.disabled = !stegoImgData;
  downloadStegoBtn.disabled = !stegoImgData;
  downloadMaskBtn.disabled = !maskUint8;
  genAiTextBtn.disabled = !(stegoImgData && maskUint8);
  polishAiTextBtn.disabled = aiText.value.trim().length === 0;
}

/* events */
imgInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  origImgData = await drawImageToCanvas(file, origCanvas);
  setStats(`Image loaded: ${origCanvas.width}×${origCanvas.height}`);
  enableControls();
});

audioInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  audioArrayBuffer = await file.arrayBuffer();
  setStats(`Audio loaded: ${(audioArrayBuffer.byteLength/1024).toFixed(1)} KB`);
  enableControls();
});

analyzeBtn.addEventListener("click", () => {
  if (!origImgData) return;
  const cap = imageCapacityBits();
  const need = requiredBits();
  setStats(`Capacity: ${(cap/8/1024).toFixed(2)} KB\nNeeded: ${(need/8/1024).toFixed(2)} KB\nImage: ${origImgData.width}×${origImgData.height}`);
});

embedBtn.addEventListener("click", async () => {
  if (!(origImgData && audioArrayBuffer)) return;
  try {
    const { stegoImageData, maskUint8: mask, usedIndices } = embedAudioInImage(origImgData, audioArrayBuffer);
    stegoImgData = stegoImageData;
    maskUint8 = mask;

    // draw stego
    stegoCanvas.width = origCanvas.width;
    stegoCanvas.height = origCanvas.height;
    stegoCanvas.getContext("2d").putImageData(stegoImgData, 0, 0);

    // draw mask
    const maskImg = maskToImageData(maskUint8, origCanvas.width, origCanvas.height);
    maskCanvas.width = origCanvas.width;
    maskCanvas.height = origCanvas.height;
    maskCanvas.getContext("2d").putImageData(maskImg, 0, 0);

    setStats(`Embedded OK. Used ${usedIndices.length} pixels (${(usedIndices.length/ (origCanvas.width*origCanvas.height) * 100).toFixed(2)}%).`);
  } catch (err) {
    if (String(err).includes("Insufficient capacity")) {
      const need = requiredBits(), cap = imageCapacityBits();
      setStats(`Insufficient capacity. Need ${need} bits, have ${cap}. Click "Rescale to Fit".`);
    } else alert(err.message || String(err));
  } finally {
    enableControls();
  }
});

extractBtn.addEventListener("click", () => {
  if (!stegoImgData) return;
  try {
    const buf = extractAudioFromImage(stegoImgData);
    lastExtractedOk = true;
    setStats(`Extraction OK. Bytes: ${buf.byteLength}`);
  } catch (e) {
    lastExtractedOk = false;
    alert("Extraction failed: " + (e.message || e));
  }
  enableControls();
});

downloadStegoBtn.addEventListener("click", async () => {
  if (!stegoImgData) return;
  const c = document.createElement("canvas");
  c.width = stegoImgData.width;
  c.height = stegoImgData.height;
  c.getContext("2d").putImageData(stegoImgData, 0, 0);
  const blob = await canvasToBlob(c, "image/png");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "stego.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

downloadMaskBtn.addEventListener("click", async () => {
  if (!maskUint8) return;
  const c = document.createElement("canvas");
  c.width = origCanvas.width;
  c.height = origCanvas.height;
  c.getContext("2d").putImageData(maskToImageData(maskUint8, c.width, c.height), 0, 0);
  const blob = await canvasToBlob(c, "image/png");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "protection-mask.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

genAiTextBtn.addEventListener("click", async () => {
  if (!(stegoImgData && maskUint8)) return;

  const stegoBlob = await canvasToBlob((() => {
    const c = document.createElement("canvas");
    c.width = stegoImgData.width; c.height = stegoImgData.height;
    c.getContext("2d").putImageData(stegoImgData, 0, 0);
    return c;
  })(), "image/png");
  const maskBlob = await canvasToBlob((() => {
    const c = document.createElement("canvas");
    c.width = origCanvas.width; c.height = origCanvas.height;
    c.getContext("2d").putImageData(maskToImageData(maskUint8, c.width, c.height), 0, 0);
    return c;
  })(), "image/png");

  const stegoUrl = URL.createObjectURL(stegoBlob);
  const maskUrl = URL.createObjectURL(maskBlob);

  const text = [
    "You are an image-editing AI. Task:",
    "- Input image contains embedded audio in the least significant bit of the RGBA channels for specific pixels.",
    "- The attached mask marks PROTECTED pixels in BLACK (0). Do not alter those pixels at all.",
    "- You may embellish only the WHITE pixels. Keep dimensions and color profile unchanged. Output must be lossless PNG.",
    "",
    "Strict requirements:",
    "1) Do not perform resampling, denoising, compression, or color quantization on black mask areas.",
    "2) Preserve exact RGBA values for black mask pixels. No alpha premultiplication changes.",
    "3) Output same width/height, no crops, no rotations.",
    "4) Save as PNG with no palette/indexing; full RGBA.",
    "",
    "Assets:",
    `- Stego PNG: ${stegoUrl}`,
    `- Protection Mask PNG (black = protected, white = editable): ${maskUrl}`,
    "",
    "Goal: Subtly improve unprotected regions (lighting, contrast, texture) while leaving protected pixels byte-for-byte identical."
  ].join("\n");

  aiText.value = text;
  polishAiTextBtn.disabled = false;
});

polishAiTextBtn.addEventListener("click", async () => {
  const base = aiText.value.trim();
  if (!base) return;
  try {
    const completion = await websim.chat.completions.create({
      messages: [
        { role: "system", content: "Rewrite the user's instructions to be concise, precise, and technically enforceable. Preserve all constraints. Output plain text only." },
        { role: "user", content: base }
      ]
    });
    aiText.value = completion.content;
  } catch {
    // keep original
  }
});

rescaleBtn.addEventListener("click", () => {
  if (!(origImgData && audioArrayBuffer)) return;
  const need = requiredBits(), cap = imageCapacityBits();
  if (cap >= need) return enableControls();
  const scale = Math.ceil(Math.sqrt(need / cap));
  const newW = origCanvas.width * scale, newH = origCanvas.height * scale;
  const src = document.createElement("canvas");
  src.width = origCanvas.width; src.height = origCanvas.height;
  src.getContext("2d").putImageData(origImgData, 0, 0);
  origCanvas.width = newW; origCanvas.height = newH;
  const ctx = origCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false; ctx.drawImage(src, 0, 0, newW, newH);
  origImgData = ctx.getImageData(0, 0, newW, newH);
  setStats(`Rescaled to ${newW}×${newH}. New capacity: ${(imageCapacityBits()/8/1024).toFixed(2)} KB`);
  enableControls();
});

/* init */
enableControls();