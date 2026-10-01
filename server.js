// 入口：只负责启动服务。
// 请求处理见 src/app.js，状态重算见 src/domain.js，记录存储见 src/store.js。
import { app, port } from "./src/app.js";

app.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
