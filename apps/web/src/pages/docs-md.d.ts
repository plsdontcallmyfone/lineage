// docs/site/*.md are bundled as text (Bun import attribute { type: "text" }), see pages/docs.ts.
declare module "*.md" {
  const text: string;
  export default text;
}
