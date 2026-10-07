// All downloads wired in one call, for createPrdApi({ exporters: createExporters(...) }).
// Server-only. Kept apart from prd-server.js so the API runs without fonts when a
// project wants reviews but no PDFs.
//
//   createExporters({
//     fonts: { regular: 'prd/fonts/Regular.ttf', bold: 'prd/fonts/Bold.ttf' },
//     screensDir: 'prd/screens',                        // deck screenshots, optional
//     processes: () => PROCESSES,                        // guided-process-docs models, optional
//     bpmn: await import('../../src/assets/bpmn-layout.js'),  // its layout module, optional
//     pitch: PITCH,                                      // prd/pitch.js → «Питч-презентация», optional
//     decks: [{ id, title, description, build: (data) => deckModel }],  // more decks, optional
//   })
//
// Presentations are a list (exporters.decks): the built-in «Презентация о ходе разработки»
// from the PRD, the pitch deck when a pitch model is given, then any custom ones. The page
// lists them on «О продукте», each downloads as PDF and PPTX: /export/deck/<id>.pdf|pptx.
import { setFonts } from './pdf.js';
import { buildReportPdf } from './report-pdf.js';
import { buildDeck, buildDeckPdf, buildDeckPptx, loadScreens } from './deck.js';
import { buildChangelogPdf } from './changelog-pdf.js';
import { buildPitchDeck } from './pitch-deck.js';
import { join } from 'node:path';

export function createExporters({ fonts = null, screensDir = 'prd/screens', processes = null, bpmn = null, pitch = null, pitchScreensDir = null, decks = [] } = {}) {
  if (fonts) setFonts(fonts);
  const deckData = async (data) => ({
    ...data,
    screens: loadScreens(screensDir),
    processes: typeof processes === 'function' ? await processes() : processes ?? [],
    bpmn,
  });
  // Презентации: встроенная «о ходе разработки» из PRD плюс свои — каждая со своим
  // build(data) → модель слайдов; PDF и PPTX рисуются из одной модели.
  const all = [
    { id: 'status', title: 'Презентация о ходе разработки', description: 'Модули, эпики и готовность по критериям приёмки — для команды и заказчика.', build: async (data) => buildDeck(await deckData(data)) },
    // Питч-презентация из prd/pitch.js (references/pitch.md): рассказ о продукте без статусов
    ...(pitch ? [{
      id: 'pitch', title: 'Питч-презентация',
      description: 'Рассказ о продукте для тех, кто его не видел: зачем он нужен, из чего состоит и кто в нём работает.',
      build: async (data) => {
        const model = typeof pitch === 'function' ? await pitch() : pitch;
        return buildPitchDeck(model, { product: data.prd?.product ?? {}, screens: loadScreens(pitchScreensDir ?? join(screensDir, 'pitch')) });
      },
    }] : []),
    ...decks,
  ];
  const status = all[0];
  return {
    reportPdf: (data) => buildReportPdf(data),
    pitchPdf: async (data) => buildDeckPdf(await status.build(data)),
    pitchPptx: async (data) => buildDeckPptx(await status.build(data)),
    changelogPdf: (data) => buildChangelogPdf(data),
    decks: all.map((d) => ({
      id: d.id, title: d.title, description: d.description,
      pdf: async (data) => buildDeckPdf(await d.build(data)),
      pptx: async (data) => buildDeckPptx(await d.build(data)),
    })),
  };
}
