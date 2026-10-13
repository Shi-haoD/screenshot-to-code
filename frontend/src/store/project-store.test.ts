import { Commit, VariantStatus } from "../components/commits/types";
import { useAppStore } from "./app-store";
import { useProjectStore } from "./project-store";

function createGeneratingCommit(): Commit {
  return {
    hash: "timed-commit",
    parentHash: null,
    dateCreated: new Date(1_000),
    isCommitted: false,
    variants: [{ code: "", history: [] }],
    selectedVariantIndex: 0,
    type: "ai_create",
    inputs: { text: "Create a page", images: [] },
  };
}

describe("version navigation", () => {
  const selectedElement = { tagName: "BUTTON" } as HTMLElement;

  beforeEach(() => {
    useProjectStore.setState({ head: "latest" });
    useAppStore.setState({
      inSelectAndEditMode: true,
      selectedElement,
    });
  });

  afterEach(() => {
    useAppStore.setState({
      inSelectAndEditMode: false,
      selectedElement: null,
    });
  });

  it("exits select-and-edit and clears its target when the head changes", () => {
    useProjectStore.getState().setHead("previous");

    expect(useProjectStore.getState().head).toBe("previous");
    expect(useAppStore.getState().inSelectAndEditMode).toBe(false);
    expect(useAppStore.getState().selectedElement).toBeNull();
  });

  it("does not exit select-and-edit when the requested head is already active", () => {
    useProjectStore.getState().setHead("latest");

    expect(useAppStore.getState().inSelectAndEditMode).toBe(true);
    expect(useAppStore.getState().selectedElement).toBe(selectedElement);
  });
});

describe("variant completion timestamps", () => {
  beforeEach(() => {
    useProjectStore.setState({
      commits: {},
      head: null,
      latestCommitHash: null,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each<VariantStatus>(["complete", "error", "cancelled"])(
    "records one stable timestamp when a variant becomes %s",
    (status) => {
      const now = jest.spyOn(Date, "now").mockReturnValue(116_000);
      const store = useProjectStore.getState();
      store.addCommit(createGeneratingCommit());
      store.updateVariantStatus("timed-commit", 0, status);

      expect(
        useProjectStore.getState().commits["timed-commit"].variants[0]
          .completedAt
      ).toBe(116_000);

      now.mockReturnValue(999_000);
      store.updateVariantStatus("timed-commit", 0, status);

      expect(
        useProjectStore.getState().commits["timed-commit"].variants[0]
          .completedAt
      ).toBe(116_000);
    }
  );
});
