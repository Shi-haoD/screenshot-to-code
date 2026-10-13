import { showHoverOverlay, showSelectionOverlay } from "./overlays";

interface FakeNode {
  id: string;
  style: Record<string, string>;
  textContent: string;
  children: FakeNode[];
  firstChild: FakeNode | null;
  appendChild: (child: FakeNode) => FakeNode;
  remove: () => void;
}

function createFakeDocument() {
  const nodes = new Map<string, FakeNode>();

  const createNode = (): FakeNode => {
    const node: FakeNode = {
      id: "",
      style: {},
      textContent: "",
      children: [],
      firstChild: null,
      appendChild(child) {
        this.children.push(child);
        this.firstChild ??= child;
        if (child.id) nodes.set(child.id, child);
        return child;
      },
      remove() {
        if (this.id) nodes.delete(this.id);
      },
    };
    return node;
  };

  const documentElement = createNode();
  documentElement.appendChild = (child) => {
    documentElement.children.push(child);
    documentElement.firstChild ??= child;
    if (child.id) nodes.set(child.id, child);
    return child;
  };

  const doc = {
    documentElement,
    createElement: () => createNode(),
    getElementById: (id: string) => nodes.get(id) ?? null,
  };

  return { doc: doc as unknown as Document, nodes };
}

function fakeElement(
  doc: Document,
  tagName: string,
  rect: { top: number; left: number; width: number; height: number }
): HTMLElement {
  return {
    id: "",
    ownerDocument: doc,
    tagName: tagName.toUpperCase(),
    getBoundingClientRect: () => rect,
  } as unknown as HTMLElement;
}

describe("select-and-edit overlays", () => {
  it("moves the hover box without any transition or animation", () => {
    const { doc, nodes } = createFakeDocument();
    const first = fakeElement(doc, "div", {
      top: 10,
      left: 20,
      width: 100,
      height: 40,
    });
    const second = fakeElement(doc, "button", {
      top: 220,
      left: 440,
      width: 80,
      height: 32,
    });

    showHoverOverlay(first);
    showHoverOverlay(second);

    const overlay = nodes.get("__s2c-hover-overlay");
    expect(overlay?.style.transition).toBe("none");
    expect(overlay?.style.animation).toBe("none");
    expect(overlay?.style.top).toBe("220px");
    expect(overlay?.style.left).toBe("440px");
    expect(overlay?.style.width).toBe("80px");
    expect(overlay?.style.height).toBe("32px");
  });

  it("keeps the locked target visually distinct from hover", () => {
    const { doc, nodes } = createFakeDocument();
    const target = fakeElement(doc, "button", {
      top: 20,
      left: 40,
      width: 100,
      height: 36,
    });

    showHoverOverlay(target);
    showSelectionOverlay(target);

    const hover = nodes.get("__s2c-hover-overlay");
    const selection = nodes.get("__s2c-selection-overlay");
    expect(selection?.style.border).not.toBe(hover?.style.border);
    expect(selection?.style.background).not.toBe(hover?.style.background);
    expect(selection?.style.top).toBe("17px");
    expect(selection?.style.left).toBe("37px");
    expect(selection?.firstChild?.textContent).toBe("✓ <button>");
  });
});
