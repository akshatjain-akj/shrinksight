import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function POST(request: Request) {
  const body = await request.json();
  const name = body.slide === 3 ? "login-layout-3.json" : body.slide === 2 ? "login-layout-2.json" : "login-layout.json";
  const data = body.spots ?? body;
  const file = path.join(process.cwd(), name);
  await writeFile(file, JSON.stringify(data, null, 2));
  return Response.json({ ok: true });
}
