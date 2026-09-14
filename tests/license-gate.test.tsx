import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LicenseGate } from "../src/license/LicenseGate";
import { getLicenseState } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({
  getLicenseState: vi.fn(),
  activateLicense: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("LicenseGate", () => {
  it("opens the private development build without a license", async () => {
    vi.mocked(getLicenseState).mockResolvedValue({
      edition: "development",
      status: "licensed",
      message: null,
      licensedTo: null,
    });
    render(<LicenseGate><div>Biblioteca privada</div></LicenseGate>);

    expect(await screen.findByText("Biblioteca privada")).toBeTruthy();
    expect(screen.getByText("DESARROLLO")).toBeTruthy();
  });

  it("does not mount the library in an unactivated commercial build", async () => {
    vi.mocked(getLicenseState).mockResolvedValue({
      edition: "commercial",
      status: "activationRequired",
      message: null,
      licensedTo: null,
    });
    render(<LicenseGate><div>Contenido protegido</div></LicenseGate>);

    expect(await screen.findByRole("heading", { name: "Activar Biblioteca Visual" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Contenido protegido")).toBeNull());
  });

  it("shows only approved user-facing errors", async () => {
    vi.mocked(getLicenseState).mockResolvedValue({
      edition: "commercial",
      status: "invalid",
      message: "internal path C:\\secret\\license.rxw",
      licensedTo: null,
    });
    render(<LicenseGate><div>Contenido protegido</div></LicenseGate>);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible validar la licencia. Intentá nuevamente",
    );
    expect(screen.queryByText(/secret/)).toBeNull();
  });
});
