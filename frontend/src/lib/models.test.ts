import {
  CODE_GENERATION_MODEL_DESCRIPTIONS,
  CodeGenerationModel,
  getVariantLabel,
} from "./models";

const FLASH_MIN = CodeGenerationModel.GEMINI_3_FLASH_PREVIEW_MINIMAL;
const PRO_HIGH = CodeGenerationModel.GEMINI_3_1_PRO_PREVIEW_HIGH;
const GPT_HIGH = CodeGenerationModel.GPT_5_5_HIGH;
const PRO_LOW = CodeGenerationModel.GEMINI_3_1_PRO_PREVIEW_LOW;

describe("Gemini 3.6 Flash", () => {
  test.each([
    [CodeGenerationModel.GEMINI_3_6_FLASH_MINIMAL, "minimal"],
    [CodeGenerationModel.GEMINI_3_6_FLASH_LOW, "low"],
    [CodeGenerationModel.GEMINI_3_6_FLASH_MEDIUM, "medium"],
    [CodeGenerationModel.GEMINI_3_6_FLASH_HIGH, "high"],
  ])("exposes the %s variant", (model, level) => {
    expect(model).toBe(`gemini-3.6-flash (${level} thinking)`);
    expect(CODE_GENERATION_MODEL_DESCRIPTIONS[model].name).toBe(
      `Gemini 3.6 Flash (${level})`
    );
  });
});

describe("getVariantLabel", () => {
  test("image/create: Flash-minimal -> Fast; Pro-high & GPT-5.5 high -> Max", () => {
    const ctx = { inputMode: "image" as const, generationType: "create" as const };
    expect(getVariantLabel(FLASH_MIN, ctx)).toEqual({ text: "Fast", tone: "fast" });
    expect(getVariantLabel(PRO_HIGH, ctx)).toEqual({ text: "Max", tone: "max" });
    expect(getVariantLabel(GPT_HIGH, ctx)).toEqual({ text: "Max", tone: "max" });
    // Flash-high stays unlabelled.
    expect(
      getVariantLabel(CodeGenerationModel.GEMINI_3_FLASH_PREVIEW_HIGH, ctx)
    ).toBeNull();
  });

  test("text/create: Flash-minimal -> Fast, GPT-5.5 high -> Max; Pro-low unlabelled", () => {
    const ctx = { inputMode: "text" as const, generationType: "create" as const };
    expect(getVariantLabel(FLASH_MIN, ctx)).toEqual({ text: "Fast", tone: "fast" });
    expect(getVariantLabel(GPT_HIGH, ctx)).toEqual({ text: "Max", tone: "max" });
    expect(getVariantLabel(PRO_LOW, ctx)).toBeNull();
  });

  test("image/update: no labels (heavyweight variants reused but unlabelled)", () => {
    const ctx = { inputMode: "image" as const, generationType: "update" as const };
    expect(getVariantLabel(FLASH_MIN, ctx)).toBeNull();
    expect(getVariantLabel(PRO_HIGH, ctx)).toBeNull();
    expect(getVariantLabel(GPT_HIGH, ctx)).toBeNull();
  });

  test("text/update: no labels", () => {
    const ctx = { inputMode: "text" as const, generationType: "update" as const };
    expect(getVariantLabel(FLASH_MIN, ctx)).toBeNull();
  });

  test("video/create and video/update: Fast and Max", () => {
    for (const generationType of ["create", "update"] as const) {
      const ctx = { inputMode: "video" as const, generationType };
      expect(getVariantLabel(FLASH_MIN, ctx)).toEqual({ text: "Fast", tone: "fast" });
      expect(getVariantLabel(PRO_HIGH, ctx)).toEqual({ text: "Max", tone: "max" });
    }
  });

  test("no model -> null", () => {
    expect(
      getVariantLabel(undefined, { inputMode: "image", generationType: "create" })
    ).toBeNull();
  });
});
