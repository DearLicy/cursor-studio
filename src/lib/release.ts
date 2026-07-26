import {
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_PROMOTIONS_URL,
  RELEASE_REPOSITORY_URL,
  RELEASE_UPDATE_MANIFEST_URL,
} from "../../shared/release-source";

/**
 * Public release metadata shared by the desktop shell and the update bridge.
 *
 * Keep repository URLs in one place so release hosting can change without
 * scattering endpoint strings across the interface.
 * The updater supplies live state through `ReleaseControl`; the UI deliberately
 * does not perform downloads or file replacement itself.
 */
export const APP_VERSION = "v1.0.3";

export const APP_RELEASE = {
  repositoryUrl: RELEASE_REPOSITORY_URL,
  releasesUrl: `${RELEASE_REPOSITORY_URL}/releases`,
  adsUrl: RELEASE_PROMOTIONS_URL,
  updateUrl: RELEASE_UPDATE_MANIFEST_URL,
  checkIntervalMs: RELEASE_CHECK_INTERVAL_MS,
} as const;

export type ReleasePromotionKind = "promotion" | "vacancy";

/** One displayable entry from ads.json. */
export interface ReleasePromotion {
  id: string;
  label: string;
  title: string;
  description: string;
  action: string;
  href: string;
  kind?: ReleasePromotionKind;
  active?: boolean;
  priority?: number;
  startsAt?: string;
  endsAt?: string;
}

/** Shape of the remotely hosted ads.json document. */
export interface ReleaseAdsManifest {
  schemaVersion: 1;
  updatedAt: string;
  items: readonly ReleasePromotion[];
}

export interface ReleaseUpdate {
  version: string;
  title?: string;
  notes?: string;
  publishedAt?: string;
  downloadUrl?: string;
  sizeBytes?: number;
  sha256?: string;
  mandatory?: boolean;
}

export type ReleaseCheckResult =
  | {
      status: "up-to-date";
      currentVersion: string;
      checkedAt?: string;
      promotions?: readonly ReleasePromotion[];
    }
  | {
      status: "available";
      currentVersion: string;
      update: ReleaseUpdate;
      checkedAt?: string;
      promotions?: readonly ReleasePromotion[];
    }
  | {
      status: "unavailable";
      currentVersion: string;
      checkedAt?: string;
      message?: string;
      promotions?: readonly ReleasePromotion[];
    };

/**
 * Snapshot owned by the application updater. The shell only renders this
 * state, so periodic checks and restart behavior remain in the native layer.
 */
export interface ReleaseUpdateState {
  checking?: boolean;
  installing?: boolean;
  lastCheckedAt?: string;
  promotions?: readonly ReleasePromotion[];
  availableUpdate?: ReleaseUpdate | null;
  error?: string | null;
}

/**
 * Injection point for the native release updater. AppRoot can construct this
 * from its IPC/API layer and pass it to HomePage without coupling page UI to
 * Electron or to a particular GitHub client.
 */
export interface ReleaseControl {
  repositoryUrl?: string;
  state?: ReleaseUpdateState;
  checkForUpdates: () => Promise<ReleaseCheckResult>;
  installUpdate: (update: ReleaseUpdate) => Promise<void>;
}

export function isReleasePromotionActive(
  promotion: ReleasePromotion,
  now = Date.now(),
): boolean {
  if (promotion.active === false) return false;

  const startsAt = promotion.startsAt ? Date.parse(promotion.startsAt) : Number.NEGATIVE_INFINITY;
  const endsAt = promotion.endsAt ? Date.parse(promotion.endsAt) : Number.POSITIVE_INFINITY;

  return (Number.isNaN(startsAt) || now >= startsAt) && (Number.isNaN(endsAt) || now <= endsAt);
}
