// 入口：仅创建 HTTP 服务并监听。
// 请求处理在 lib/handlers.js，状态重算在 lib/domain.js，记录存储在 lib/store.js。

import http from "node:http";
import { handle } from "./lib/handlers.js";

const port = Number(process.env.PORT || 3025);

const server = http.createServer(handle);
server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
