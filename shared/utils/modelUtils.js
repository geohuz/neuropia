export function inferProviderFromModel(model) {
  if (
    model.includes("qwen") ||
    model.includes("百炼") ||
    model.includes("bailian")
  )
    return "dashscope";
  if (model.includes("gpt")) return "openai";
  if (model.includes("claude")) return "anthropic";
  if (model.includes("ERNIE") || model.includes("文心")) return "baidu";
  return "dashscope";
}
