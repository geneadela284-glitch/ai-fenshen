import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const source = (name) => readFile(new URL(name, root), 'utf8');

test('composer paperclip is covered by one directly activated native image input', async () => {
  const composer = await source('ChatComposer.jsx');
  const css = await source('aiFenshenPrototype.css');
  const attachControl = composer.match(
    /<div className="af-attach-wrap">[\s\S]*?<\/div>/
  )?.[0] || '';
  assert.equal((composer.match(/type="file"/g) || []).length, 1);
  assert.match(attachControl, /className="af-attachment-input"/);
  assert.match(attachControl, /accept="image\/jpeg,image\/png,image\/webp,image\/heic,image\/heif"/);
  assert.match(attachControl, /\bmultiple\b/);
  assert.match(attachControl, /onChange=\{handleSelectedFiles\}/);
  assert.match(attachControl, /onCancel=\{\(event\) => \{ event\.currentTarget\.value = ''; \}\}/);
  assert.match(attachControl, /aria-label="添加图片"/);
  assert.match(composer, /const selected = Array\.from\(input\.files \|\| \[\]\)/);
  assert.match(composer, /input\.value = ''/);
  assert.match(composer, /if \(selected\.length\) onSelectImages\?\.\(selected\)/);
  assert.match(composer, /onSelectImages/);
  assert.doesNotMatch(composer, /toggleAttachmentMenu|attachmentMenuOpen|openAttachmentPicker/);
  assert.doesNotMatch(composer, /showPicker|\.click\(|capture=/);
  assert.doesNotMatch(attachControl, /onTouchEnd|onPointerDown/);
  assert.equal((attachControl.match(/onClick=/g) || []).length, 1);
  assert.doesNotMatch(composer, /拍照<\/button>|相片<\/button>|选择文件<\/button>|af-attach-menu/);
  assert.match(css, /\.af-attach-wrap\s*\{[^}]*position:\s*relative[^}]*width:\s*46px[^}]*height:\s*46px/s);
  assert.match(css, /\.af-attachment-input\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%[^}]*opacity:\s*0[^}]*pointer-events:\s*auto[^}]*z-index:\s*2/s);
  assert.doesNotMatch(css, /\.af-attachment-input\s*\{[^}]*(display:\s*none|visibility:\s*hidden|clip:|clip-path:|left:\s*-)/s);
});

test('real app sends owner-safe attachment ids and never keeps image base64 in local storage', async () => {
  const app = await source('AIFenshenRealApp.jsx');
  const uploadCall = app.match(/attachmentClient\.upload\(\{[\s\S]*?\}\)/)?.[0] || '';
  assert.match(app, /createAttachmentClient/);
  assert.match(app, /attachmentIds/);
  assert.match(app, /addSelectedImages/);
  assert.match(app, /getCapabilities/);
  assert.match(uploadCall, /conversationId/);
  assert.match(uploadCall, /clientRequestId/);
  assert.doesNotMatch(uploadCall, /ownerId|providerName|modelName/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*base64/i);
  assert.doesNotMatch(app, /providerName|modelName/);
});

test('sent attachment messages expose authenticated thumbnails, lifecycle status and deletion', async () => {
  const message = await source('ChatMessage.jsx');
  const css = await source('aiFenshenPrototype.css');
  assert.match(message, /attachments/);
  assert.match(message, /attachmentContentUrl/);
  assert.match(message, /onDeleteAttachment/);
  assert.match(message, /processed_partial/);
  assert.match(message, /limitations/);
  assert.match(message, /af-message-attachments.*is-single/);
  assert.match(css, /\.af-message-image-open\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.af-message-image-open img\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*object-fit:\s*contain/s);
  assert.doesNotMatch(css, /\.af-message-image-open img\s*\{[^}]*object-fit:\s*cover/s);
  assert.doesNotMatch(message, /provider|model|storage_reference|serverPath/i);
});

test('image preview has explicit, backdrop, swipe, Escape and browser-back close paths with lifecycle cleanup', async () => {
  const message = await source('ChatMessage.jsx');
  const css = await source('aiFenshenPrototype.css');
  assert.match(message, /af-image-preview-close/);
  assert.match(message, /event\.target === event\.currentTarget/);
  assert.match(message, /onTouchStart/);
  assert.match(message, /onTouchEnd/);
  assert.match(message, /popstate/);
  assert.match(message, /event\.key === 'Escape'/);
  assert.match(message, /history\.pushState/);
  assert.match(message, /history\.back/);
  assert.match(message, /createPortal/);
  assert.match(message, /document\.body/);
  assert.match(message, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(message, /document\.body\.style\.overflow = previousOverflow/);
  assert.match(message, /preview\?\.attachmentId === attachmentId/);
  assert.match(css, /\.af-image-preview-modal\s*\{[^}]*100dvh[^}]*safe-area-inset-top[^}]*safe-area-inset-bottom/s);
  assert.match(css, /\.af-image-preview-modal img\s*\{[^}]*object-fit:\s*contain[^}]*touch-action:\s*pinch-zoom/s);
});
