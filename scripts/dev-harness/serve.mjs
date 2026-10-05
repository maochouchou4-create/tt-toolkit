// dev-harness 静态服务器：file:// 协议被部分工具（Playwright 等）封锁时，
// 用 node scripts/dev-harness/serve.mjs [端口]（默认 4173）从仓根起一个
// 只读静态服务，访问 http://127.0.0.1:4173/scripts/dev-harness/ 即可。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.argv[2] ?? 4173);
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
};

createServer((req, res) => {
    void (async () => {
        try {
            const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
            // 路径穿越守门：解析后的绝对路径必须仍在仓内
            const path = normalize(join(root, url));
            if (!path.startsWith(root)) {
                res.writeHead(403).end('forbidden');
                return;
            }
            const file = extname(path) === '' ? join(path, 'index.html') : path;
            const data = await readFile(file);
            res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
            res.end(data);
        } catch {
            res.writeHead(404).end('not found');
        }
    })();
}).listen(port, '127.0.0.1', () => {
    console.log(`dev-harness: http://127.0.0.1:${port}/scripts/dev-harness/`);
});
