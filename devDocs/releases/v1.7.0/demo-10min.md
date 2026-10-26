# 1.7 Admin 演示脚本（≤ 10 分钟）

```bash
# 1. 建库 + 样例数据
jsonsqlite init -p ./demo17
jsonsqlite table create --name users --field name:string --field age:number -p ./demo17
jsonsqlite insert users --data '{"name":"Ann","age":30}' -p ./demo17
jsonsqlite insert users --data '{"name":"Bob","age":17}' -p ./demo17

# 2. 启动 Admin（loopback）
jsonsqlite admin serve --host 127.0.0.1 --port 3000 -p ./demo17
# 浏览器打开 http://127.0.0.1:3000/admin

# 3. 仪表盘：看指标 → 跑查询 → 看慢查询
# 4. Advise：粘贴 {"collection":"users","filter":{"age":{"$gte":18}}} → Advise
# 5. Backup：点 Full backup
# 6. Time travel：填 collection=users、timestamp=当前毫秒 → Query at time
# 7. 另开终端写入，观察 SSE live + tables 刷新
jsonsqlite insert users --data '{"name":"Cara","age":22}' -p ./demo17
```

库侧等价：`await db.startServer({ host:'127.0.0.1', port:3000 })`
