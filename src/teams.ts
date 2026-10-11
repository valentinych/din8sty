/** Celestial primer teams (stable ids 1..16, match primer-draft.json). */
export const CELESTIAL_TEAMS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: "Сатурн" },
  { id: 2, name: "Марс" },
  { id: 3, name: "Венера" },
  { id: 4, name: "Церера" },
  { id: 5, name: "Юпитер" },
  { id: 6, name: "Нептун" },
  { id: 7, name: "Уран" },
  { id: 8, name: "Меркурий" },
  { id: 9, name: "Плутон" },
  { id: 10, name: "Европа" },
  { id: 11, name: "Титан" },
  { id: 12, name: "Ио" },
  { id: 13, name: "Каллисто" },
  { id: 14, name: "Ганимед" },
  { id: 15, name: "Луна" },
  { id: 16, name: "Солнце" },
] as const;

export function teamById(id: number): { id: number; name: string } | null {
  return CELESTIAL_TEAMS.find((t) => t.id === id) ?? null;
}
