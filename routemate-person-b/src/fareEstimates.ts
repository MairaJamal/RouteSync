export interface ProviderTariff {
  provider: string;
  baseFare: number;
  perKm: number;
  perMin: number;
  minFare: number;
  liveCheckUrl: string | null;
}

// Islamabad car tariffs (PKR), calibrated against observed app quotes.
// Tunable at runtime via env for demo/day-of pricing changes.
export const PROVIDER_TARIFFS: ProviderTariff[] = [
  {
    provider: "InDrive",
    baseFare: Number(process.env.INDRIVE_BASE_FARE ?? 150),
    perKm: Number(process.env.INDRIVE_PER_KM ?? 55),
    perMin: Number(process.env.INDRIVE_PER_MIN ?? 8),
    minFare: Number(process.env.INDRIVE_MIN_FARE ?? 200),
    liveCheckUrl: "https://indrive.com/",
  },
  {
    provider: "Bykea (car)",
    baseFare: Number(process.env.BYKEA_BASE_FARE ?? 120),
    perKm: Number(process.env.BYKEA_PER_KM ?? 50),
    perMin: Number(process.env.BYKEA_PER_MIN ?? 7),
    minFare: Number(process.env.BYKEA_MIN_FARE ?? 150),
    liveCheckUrl: "https://www.bykea.com/",
  },
  {
    provider: "Yango",
    baseFare: Number(process.env.YANGO_BASE_FARE ?? 170),
    perKm: Number(process.env.YANGO_PER_KM ?? 58),
    perMin: Number(process.env.YANGO_PER_MIN ?? 8),
    minFare: Number(process.env.YANGO_MIN_FARE ?? 220),
    liveCheckUrl: "https://yango.com/",
  },
];

export interface SoloFareEstimate {
  provider: string;
  price: number;
  live_check_url: string | null;
}

export function estimateSoloFares(
  distanceM: number,
  durationS: number,
  tariffs: ProviderTariff[] = PROVIDER_TARIFFS
): SoloFareEstimate[] {
  return tariffs.map((t) => {
    const raw =
      t.baseFare + (distanceM / 1000) * t.perKm + (durationS / 60) * t.perMin;
    return {
      provider: t.provider,
      price: Math.round(Math.max(raw, t.minFare)),
      live_check_url: t.liveCheckUrl,
    };
  });
}
