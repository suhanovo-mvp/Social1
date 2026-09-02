// Выгрузка схем процессов в PDF. Схемы — справочный материал платформы,
// поэтому доступны любому участнику после входа.
import { route, HttpError } from '../http.js';
import { logAction } from '../audit.js';
import { diagramPdf, albumPdf } from '../bpmn-pdf.js';
import { DIAGRAMS } from '../../web/js/processes-data.js';

const fileName = (s) => String(s)
  .replace(/[«»"]/g, '').replace(/[^\wА-Яа-яЁё0-9-]+/g, '_').replace(/_+/g, '_').slice(0, 80);

function sendPdf(res, buf, name) {
  // filename* с кодировкой UTF-8 — иначе браузер испортит кириллицу в имени файла
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="social1.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// Перечень схем — для клиента и для проверки доступности выгрузки
route.get('/api/processes', async ({ sendJson }) => {
  sendJson(200, DIAGRAMS.map((d, i) => ({
    seq: i + 1, id: d.id, role: d.role, group: d.group,
    title: d.title, sla: d.sla || null,
    nodes: d.nodes.length, steps: d.walkthrough?.length || 0,
  })));
});

// Альбом всех схем: титул, содержание, по странице на схему
route.get('/api/processes/album/pdf', async ({ user, ip, res }) => {
  const buf = albumPdf();
  logAction(user.id, 'processes.export', 'processes', null, { kind: 'album', pages: DIAGRAMS.length + 2 }, ip);
  sendPdf(res, buf, `Social1_Схемы_процессов_${new Date().toISOString().slice(0, 10)}.pdf`);
});

// Одна схема
route.get('/api/processes/:id/pdf', async ({ user, params, ip, res }) => {
  const d = DIAGRAMS.find((x) => x.id === params.id) || DIAGRAMS[Number(params.id) - 1];
  if (!d) throw new HttpError(404, 'Схема не найдена');
  const seq = DIAGRAMS.indexOf(d) + 1;
  const buf = diagramPdf(d);
  logAction(user.id, 'processes.export', 'processes', seq, { kind: 'diagram', id: d.id }, ip);
  sendPdf(res, buf, `Social1_${seq}_${fileName(d.title)}.pdf`);
});
