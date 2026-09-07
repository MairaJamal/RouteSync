import { useEffect, useState } from "react";
import LocationSearchForm, { TripSearchValue, UserRole } from "./LocationSearchForm";
import { authedFetch, restoreSession, signOut, AuthUserSession } from "./demoAuth";
import AuthScreen from "./AuthScreen";
import UserDashboard from "./UserDashboard";
import MatchCard, { MatchCardSkeleton } from "./MatchCard";
import FareComparisonCard, { SoloFareEstimateView } from "./FareComparisonCard";
import MatchChatDrawer, { ConfirmedMatchInfo } from "./MatchChatDrawer";
import PendingConsentsPanel from "./PendingConsentsPanel";
import SharedRideBrowser from "./SharedRideBrowser";
import NotificationBell from "./NotificationBell";
import NaturalLanguageTripInput, { ParsedTripDraft } from "./NaturalLanguageTripInput";
import { co2SavedSummary } from "../carbonImpact";
import SosButton from "./SosButton";
import EmergencyContactsSection from "./EmergencyContactsSection";
import VehicleDeclarationSection from "./VehicleDeclarationSection";
import RatingModal from "./RatingModal";
import VerifiedBadge from "./VerifiedBadge";
import { LabeledLeg } from "../matchPipeline";
import { Gender, RatingSummary, GeoJSONLineString } from "../types";
import "./tokens.css";

interface RouteGeometryBundle {
  requester: GeoJSONLineString | null;
  candidate: GeoJSONLineString | null;
  combined: GeoJSONLineString | null;
}

interface MatchItem {
  id: string;
  candidateDisplayName: string;
  candidateUserId?: string;
  candidatePhone: string;
  candidateSectorFrom: string;
  candidateSectorTo: string;
  candidateIsVerified?: boolean;
  candidateVerifiedDomain?: string | null;
  candidateRating?: RatingSummary | null;
  candidatePreference?: "any" | "male_only" | "female_only";
  overlapPct: number;
  detourAddedMinutes: number;
  legs: LabeledLeg[];
  routeGeometry?: RouteGeometryBundle;
  fareSplit: { user_id: string; total_fare: number; distance_share_pct?: number; distance_km?: number }[];
  matchType?: "peer_share" | "owner_passenger" | "shared_ride_hailing";
  ownerUserId?: string;
  vehicleType?: "none" | "car" | "bike" | "ride_hailing";
  /** Only set when matchType === "shared_ride_hailing". */
  sharedFarePkr?: number;
  sharedFareNote?: string;
  ownerVehicleDeclared?: boolean;
  ownerVehiclePlate?: string | null;
  ownerVehicleMakeModel?: string | null;
  status: "pending" | "confirmed";
  rideId?: string;
  /** Live chat thread id after Accept (shared with the other user). */
  chatId?: string;
}

interface UserProfile {
  display_name: string;
  gender: Gender;
  is_verified: boolean;
  verified_domain: string | null;
}

interface PendingRating {
  rideId: string;
  userId: string;
  displayName: string;
}

const API_URL = (import.meta as any).env?.VITE_API_URL ?? "";
export type LegColor = "blue" | "green" | "purple";

// Reference-only solo-fare rows for the comparison card — used only when
// the backend hasn't supplied live estimates, and the card clearly labels
// them "(sample)". These never masquerade as match results: every match
// shown in the feed comes from the live matching RPC.
const DEMO_SOLO_ESTIMATES: SoloFareEstimateView[] = [
  { provider: "InDrive", price: 580, live_check_url: "https://indrive.com/" },
  { provider: "Bykea (car)", price: 520, live_check_url: "https://www.bykea.com/" },
  { provider: "Yango", price: 610, live_check_url: "https://yango.com/" },
];

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [authSession, setAuthSession] = useState<AuthUserSession | null>(null);
  const currentUserId = authSession?.userId ?? "";
  const preferredRole: UserRole = authSession?.preferredRole ?? "LOOKING";

  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [matches, setMatches] = useState<MatchItem[]>([]);
  const [confirmedMatches, setConfirmedMatches] = useState<MatchItem[]>([]);
  const [searchCriteria, setSearchCriteria] = useState<TripSearchValue | null>(null);
  const [activeChatMatch, setActiveChatMatch] = useState<ConfirmedMatchInfo | null>(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);
  const [soloEstimates, setSoloEstimates] = useState<SoloFareEstimateView[]>([]);
  const [nlDraft, setNlDraft] = useState<ParsedTripDraft | null>(null);

  // Day 7 state
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [activeTripRequestId, setActiveTripRequestId] = useState<string | null>(null);
  const [ratingQueue, setRatingQueue] = useState<PendingRating[]>([]);
  const [safetyNotice, setSafetyNotice] = useState<string | null>(null);
  const [carbonNotice, setCarbonNotice] = useState<string | null>(null);

  // Theme state (Dark/Light mode)
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    return (typeof window !== "undefined" && (localStorage.getItem("rm_theme") as "light" | "dark")) || "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("rm_theme", theme);
  }, [theme]);

  // Restore an existing Supabase session on first load; otherwise the
  // login / signup screen is shown before any trip UI.
  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((session) => {
        if (!cancelled && session) setAuthSession(session);
      })
      .catch(() => {
        /* stay signed out — AuthScreen will handle first-open login */
      })
      .finally(() => {
        if (!cancelled) setAuthChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the signed-in user's profile for header badge + safety filters.
  useEffect(() => {
    if (!authSession) {
      setUserProfile(null);
      return;
    }
    setUserProfile({
      display_name: authSession.displayName,
      gender: authSession.gender,
      is_verified: authSession.isVerified,
      verified_domain: authSession.verifiedDomain,
    });
    fetch(`${API_URL}/api/users/${authSession.userId}/profile`)
      .then((res) => (res.ok ? res.json() : null))
      .then((p) => {
        if (p && p.display_name) {
          setUserProfile({
            display_name: p.display_name,
            gender: p.gender,
            is_verified: p.is_verified === true,
            verified_domain: p.verified_domain ?? null,
          });
        }
      })
      .catch(() => {
        /* keep session-derived profile */
      });
  }, [authSession]);

  // Merge inbound Accept chats from the other user into the confirmed list.
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;

    async function pullChats() {
      try {
        const res = await authedFetch(`${API_URL}/api/users/${currentUserId}/match-chats`);
        if (!res.ok || cancelled) return;
        const payload = await res.json();
        const inbound = (payload.chats ?? []) as Array<{
          chat_id: string;
          peer_user_id: string;
          peer_display_name: string;
          origin_label: string;
          destination_label: string;
          fare_share_pkr: number;
          ride_id: string | null;
        }>;
        if (!inbound.length || cancelled) return;

        setConfirmedMatches((prev) => {
          const existingChatIds = new Set(prev.filter((m) => m.chatId).map((m) => m.chatId!));
          let next = prev.map((m) => ({ ...m }));
          for (const c of inbound) {
            if (existingChatIds.has(c.chat_id)) continue;
            const idx = next.findIndex(
              (m) => m.candidateUserId === c.peer_user_id && m.status === "confirmed"
            );
            if (idx >= 0) {
              next[idx] = { ...next[idx], chatId: c.chat_id };
              existingChatIds.add(c.chat_id);
              continue;
            }
            existingChatIds.add(c.chat_id);
            next = [
              {
                id: c.chat_id,
                chatId: c.chat_id,
                candidateDisplayName: c.peer_display_name,
                candidateUserId: c.peer_user_id,
                candidatePhone: "Use in-app chat",
                candidateSectorFrom: c.origin_label,
                candidateSectorTo: c.destination_label,
                fareSplit: [
                  { user_id: currentUserId, total_fare: c.fare_share_pkr },
                  { user_id: c.peer_user_id, total_fare: c.fare_share_pkr },
                ],
                overlapPct: 0,
                detourAddedMinutes: 0,
                legs: [],
                status: "confirmed",
                rideId: c.ride_id ?? undefined,
              },
              ...next,
            ];
          }
          return next;
        });
      } catch {
        /* ignore poll errors */
      }
    }

    pullChats();
    const t = setInterval(pullChats, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [currentUserId]);

  if (authChecking) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--rm-paper)",
          color: "var(--rm-ink-soft)",
          fontFamily: "var(--rm-font-body)",
          fontSize: "14px",
        }}
      >
        Loading RouteSync…
      </div>
    );
  }

  if (!authSession) {
    return <AuthScreen onSuccess={setAuthSession} />;
  }

  async function handleSearch(val: TripSearchValue) {
    setSearchCriteria(val);
    setLoading(true);
    setSearched(true);
    setDemoNotice(null);
    setSafetyNotice(null);

    if (!currentUserId) {
      setMatches([]);
      setSoloEstimates([]);
      setDemoNotice("Sign in again to search for live ride matches.");
      setLoading(false);
      return;
    }

    try {
      if (val.vehicleDeclaration) {
        const vehBody: Record<string, string> = {
          vehicle_plate: val.vehicleDeclaration.plate,
          vehicle_make_model: val.vehicleDeclaration.makeModel,
        };
        if (val.vehicleDeclaration.cnic) {
          vehBody.cnic_number = val.vehicleDeclaration.cnic;
        }
        const vehRes = await authedFetch(`${API_URL}/api/users/${currentUserId}/vehicle-declaration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vehBody),
        });
        if (vehRes.status === 400) {
          const body = await vehRes.json().catch(() => null);
          if (body?.error === "INVALID_CNIC") {
            throw new Error(
              "Add your CNIC on signup (or re-create the account) before offering a ride."
            );
          }
          throw new Error(body?.details ?? body?.error ?? "Invalid vehicle details.");
        }
        if (vehRes.status !== 503 && !vehRes.ok) {
          const body = await vehRes.json().catch(() => null);
          throw new Error(body?.details ?? body?.error ?? "Could not save vehicle details.");
        }
      }

      const [hh, mm] = val.departureTime.split(":").map((n) => Number(n));
      const departureAt = new Date();
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        departureAt.setHours(hh, mm, 0, 0);
      }

      const createBody: Record<string, any> = {
        user_id: currentUserId,
        origin: val.origin,
        destination: val.destination,
        requested_departure_at: departureAt.toISOString(),
        window_minutes: val.flexibilityMinutes,
        preference: val.genderPreference ?? "any",
        // Always persist vehicle role so driver (car/bike) ↔ passenger (none)
        // pairs are visible to the live matcher, not only to the mock dataset.
        vehicle_type: val.vehicleType ?? "none",
      };
      if (val.requireDriverGenderMatch) {
        createBody.require_driver_gender_match = true;
      }
      if (val.vehicleType === "ride_hailing") {
        createBody.ride_hailing_fare_pkr = val.rideHailingFarePkr;
      }

      const createRes = await authedFetch(`${API_URL}/api/trip-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });

      if (createRes.status === 503) {
        const body = await createRes.json().catch(() => null);
        throw new Error(
          body?.details ?? "This option needs a database migration to be applied first."
        );
      }
      if (createRes.status === 400) {
        const body = await createRes.json().catch(() => null);
        if (body?.error === "RIDE_HAILING_FARE_REQUIRED") {
          throw new Error("Enter the fare the ride-hailing app quoted you before searching.");
        }
        throw new Error(body?.details ?? body?.error ?? `Trip request creation failed (${createRes.status})`);
      }
      if (createRes.status === 401 || createRes.status === 403) {
        throw new Error("Auth expired — sign out and sign in again, then retry your search.");
      }
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => null);
        throw new Error(body?.details ?? body?.error ?? `Trip request creation failed (${createRes.status})`);
      }
      const { trip_request_id } = await createRes.json();
      setActiveTripRequestId(trip_request_id);

      const matchesUrl = `${API_URL}/api/trip-requests/${trip_request_id}/matches${
        val.verifiedOnly ? "?verified_only=true" : ""
      }`;
      const matchesRes = await fetch(matchesUrl);
      if (!matchesRes.ok) {
        const body = await matchesRes.json().catch(() => null);
        throw new Error(body?.details ?? body?.error ?? `Match lookup failed (${matchesRes.status})`);
      }
      const payload = await matchesRes.json();

      if (payload.verified_only_unavailable) {
        setSafetyNotice(
          "The 'verified users only' filter couldn't be applied yet (Day 7 migration pending) — showing all matches instead."
        );
      }

      const liveMatches: MatchItem[] = (payload.matches ?? []).map((m: any) => ({
        id: m.candidate_request_id,
        candidateDisplayName: m.candidate_display_name,
        candidateUserId: m.candidate_user_id,
        candidatePhone: "Shared after confirmation",
        candidateSectorFrom: m.candidate_origin_label,
        candidateSectorTo: m.candidate_destination_label,
        candidateIsVerified: m.candidate_is_verified === true,
        candidateVerifiedDomain: m.candidate_verified_domain ?? null,
        candidateRating: m.candidate_rating ?? null,
        candidatePreference: m.candidate_preference ?? "any",
        overlapPct: m.overlap_pct,
        detourAddedMinutes: m.detour_added_minutes,
        legs: m.legs,
        routeGeometry: m.route_geometry,
        fareSplit: m.fare_split,
        matchType: m.match_type,
        ownerUserId: m.owner_user_id,
        vehicleType: m.vehicle_type,
        sharedFarePkr: m.shared_fare_pkr,
        sharedFareNote: m.shared_fare_note,
        ownerVehicleDeclared: m.owner_vehicle_declared,
        ownerVehiclePlate: m.owner_vehicle_plate,
        ownerVehicleMakeModel: m.owner_vehicle_make_model,
        status: "pending",
      }));

      setMatches(liveMatches);
      setSoloEstimates(payload.solo_fare_estimates ?? []);
      if (liveMatches.length === 0) {
        setDemoNotice(
          "No overlapping riders yet. Have the other person post the same route (similar time), then search again."
        );
      }
    } catch (err: any) {
      console.warn("[RouteSync] Live ride matching failed:", err instanceof Error ? err.message : err);
      setMatches([]);
      setSoloEstimates([]);
      setDemoNotice(
        `Could not load live matches: ${err instanceof Error ? err.message : "unknown error"}`
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleAccept(id: string) {
    const matchToConfirm = matches.find((m) => m.id === id);
    if (!matchToConfirm) return;

    const confirmed: MatchItem = { ...matchToConfirm, status: "confirmed" };

    setMatches((prev) => prev.filter((m) => m.id !== id));

    // Day 7: confirming a match creates the ride row that post-trip
    // ratings hang off. On a pre-migration database this 503s — the match
    // still confirms locally, ratings just aren't available yet.
    if (currentUserId && searchCriteria) {
      try {
        const dep = new Date();
        const [hh, mm] = searchCriteria.departureTime.split(":").map(Number);
        if (Number.isFinite(hh) && Number.isFinite(mm)) dep.setHours(hh, mm, 0, 0);

        const res = await authedFetch(`${API_URL}/api/rides`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driver_id: currentUserId,
            origin: searchCriteria.origin,
            destination: searchCriteria.destination,
            departure_time: dep.toISOString(),
          }),
        });
        if (res.status === 201) {
          const { ride_id } = await res.json();
          confirmed.rideId = ride_id;
        } else if (res.status === 503) {
          setSafetyNotice("Trip confirmed — post-trip ratings need the Day 7 database migration first.");
        }
      } catch {
        // Ride creation is best-effort; the match confirmation stands.
      }
    }

    const activeUserSplit = matchToConfirm.fareSplit.find((f) => f.user_id === currentUserId);
    const fareSharePKR = activeUserSplit?.total_fare ?? matchToConfirm.fareSplit[0]?.total_fare ?? 0;

    // Open a real shared chat thread so the other user can message back.
    if (currentUserId && matchToConfirm.candidateUserId) {
      try {
        const chatRes = await authedFetch(`${API_URL}/api/match-chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            my_user_id: currentUserId,
            my_display_name: userProfile?.display_name ?? "You",
            peer_user_id: matchToConfirm.candidateUserId,
            peer_display_name: matchToConfirm.candidateDisplayName,
            origin_label: matchToConfirm.candidateSectorFrom,
            destination_label: matchToConfirm.candidateSectorTo,
            fare_share_pkr: fareSharePKR,
            ride_id: confirmed.rideId ?? null,
          }),
        });
        if (chatRes.ok) {
          const chatPayload = await chatRes.json();
          confirmed.chatId = chatPayload.chat_id;
        } else {
          setSafetyNotice("Match confirmed, but chat couldn't start — check the API is running.");
        }
      } catch {
        setSafetyNotice("Match confirmed, but chat couldn't start — check the API is running.");
      }
    }

    setConfirmedMatches((prev) => [confirmed, ...prev]);

    // Day 9: show the CO2 impact right when the share is confirmed, not
    // just once earlier on the fare-estimate card.
    const sharedDistanceKm = matchToConfirm.legs?.find((l) => l.name === "shared_overlap")
      ? Math.round(matchToConfirm.legs.find((l) => l.name === "shared_overlap")!.distance_m / 100) / 10
      : 8.5;
    const riderCount = 2;
    const carbonSummary = co2SavedSummary(sharedDistanceKm, riderCount);
    if (carbonSummary) setCarbonNotice(carbonSummary);

    setActiveChatMatch({
      id: confirmed.id,
      chatId: confirmed.chatId,
      candidateDisplayName: confirmed.candidateDisplayName,
      candidatePhone: confirmed.candidatePhone,
      candidateSectorFrom: confirmed.candidateSectorFrom,
      candidateSectorTo: confirmed.candidateSectorTo,
      fareSharePKR,
      sharedDistanceKm,
      riderCount,
    });
  }

  function handleReject(id: string) {
    setMatches((prev) => prev.filter((m) => m.id !== id));
  }

  /** Day 7: blocking hides the candidate immediately, in both lists.
   *  The server-side block makes the exclusion permanent for future
   *  matches; the local removal covers this session. */
  function handleBlocked(candidateUserId: string | undefined) {
    if (!candidateUserId) return;
    setMatches((prev) => prev.filter((m) => m.candidateUserId !== candidateUserId));
    setConfirmedMatches((prev) => prev.filter((m) => m.candidateUserId !== candidateUserId));
    setActiveChatMatch(null);
  }

  /** Day 7: complete a finished ride, then queue a "Rate your trip"
   *  modal for every other rider on it. */
  async function handleCompleteTrip(matchItem: MatchItem) {
    if (!matchItem.rideId) {
      setSafetyNotice("This ride has no ride record (Day 7 migration pending), so it can't be rated.");
      return;
    }
    try {
      const res = await authedFetch(`${API_URL}/api/rides/${matchItem.rideId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: currentUserId }),
      });
      if (res.status === 503) {
        setSafetyNotice("Ride completion isn't enabled on this database yet (Day 7 migration pending).");
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setSafetyNotice(payload.details || payload.error || "Couldn't complete the ride.");
        return;
      }
      const payload = await res.json();
      const riders: PendingRating[] = (payload.ratable_riders ?? []).map((r: any) => ({
        rideId: payload.ride_id,
        userId: r.user_id,
        displayName: r.display_name,
      }));
      setConfirmedMatches((prev) => prev.filter((m) => m.id !== matchItem.id));
      if (riders.length > 0) {
        setRatingQueue(riders);
      } else {
        setSafetyNotice("Trip completed — nobody else was on the ride to rate.");
      }
    } catch {
      setSafetyNotice("Couldn't reach the server to complete the ride.");
    }
  }

  function openChatForMatch(m: MatchItem) {
    const activeUserSplit = m.fareSplit.find((f) => f.user_id === currentUserId);
    const fareSharePKR = activeUserSplit?.total_fare ?? m.fareSplit[0]?.total_fare ?? 0;

    setActiveChatMatch({
      id: m.id,
      chatId: m.chatId,
      candidateDisplayName: m.candidateDisplayName,
      candidatePhone: m.candidatePhone,
      candidateSectorFrom: m.candidateSectorFrom,
      candidateSectorTo: m.candidateSectorTo,
      fareSharePKR,
    });
  }

  const activeUserFare =
    matches[0]?.fareSplit.find((f) => f.user_id === currentUserId)?.total_fare ??
    matches[0]?.fareSplit[0]?.total_fare ??
    240;

  return (
    <div
      style={{
        background: "var(--rm-paper)",
        minHeight: "100vh",
        color: "var(--rm-ink)",
        fontFamily: "var(--rm-font-body)",
      }}
    >
      {/* Header */}
      <header
        style={{
          borderBottom: "1px solid var(--rm-border)",
          background: "var(--rm-paper-raised)",
          padding: "16px 20px",
        }}
      >
        <div
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                background: "var(--rm-signal)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "16px",
                fontWeight: 700,
                color: "var(--rm-signal-ink)",
                fontFamily: "var(--rm-font-display)",
              }}
            >
              RS
            </div>
            <div>
              <h1
                style={{
                  margin: 0,
                  fontSize: "18px",
                  fontFamily: "var(--rm-font-display)",
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                }}
              >
                RouteSync
              </h1>
              <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
                Islamabad Carpool Matcher
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {currentUserId && <NotificationBell userId={currentUserId} />}
            {userProfile && (
              <button
                type="button"
                title="Open your dashboard"
                onClick={() => setDashboardOpen(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "11px",
                  fontFamily: "var(--rm-font-display)",
                  background: "var(--rm-paper)",
                  border: "1px solid var(--rm-border)",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  color: "var(--rm-ink)",
                  maxWidth: "180px",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                {userProfile.display_name}
                {userProfile.is_verified && (
                  <VerifiedBadge domain={userProfile.verified_domain} compact />
                )}
              </button>
            )}
            <button
              type="button"
              title="Sign out"
              onClick={async () => {
                await signOut();
                setAuthSession(null);
              }}
              style={{
                fontSize: "11px",
                fontFamily: "var(--rm-font-display)",
                background: "var(--rm-paper)",
                border: "1px solid var(--rm-border)",
                padding: "3px 8px",
                borderRadius: "6px",
                color: "var(--rm-ink)",
                cursor: "pointer",
              }}
            >
              Sign out
            </button>
            <span
              style={{
                fontSize: "11px",
                fontFamily: "var(--rm-font-display)",
                background: "var(--rm-paper)",
                border: "1px solid var(--rm-border)",
                padding: "3px 8px",
                borderRadius: "6px",
              }}
            >
              ISB GRID
            </span>
            <button
              type="button"
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              title="Toggle Light / Dark Mode"
              style={{
                fontSize: "11px",
                fontFamily: "var(--rm-font-display)",
                fontWeight: 600,
                background: "var(--rm-paper)",
                border: "1px solid var(--rm-border)",
                color: "var(--rm-ink)",
                padding: "3px 8px",
                borderRadius: "6px",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main
        style={{
          maxWidth: "600px",
          margin: "0 auto",
          padding: "20px 16px 40px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Search Form */}
        <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <NaturalLanguageTripInput onParsed={(draft) => setNlDraft(draft)} />
          <LocationSearchForm
            onSubmit={handleSearch}
            currentUserGender={userProfile?.gender}
            initialUserRole={preferredRole}
            draft={nlDraft}
          />
        </section>

        {/* Day 9: group-consent votes waiting on this rider, shown right
            up top since they're time-sensitive for whoever's waiting. */}
        {currentUserId && <PendingConsentsPanel userId={currentUserId} />}

        {/* Day 9: browse and request a seat on an already-active pooled
            ride, separate from the 1:1 match flow above. */}
        {currentUserId && (
          <SharedRideBrowser
            userId={currentUserId}
            pickupPoint={searchCriteria?.origin}
            dropoffPoint={searchCriteria?.destination}
          />
        )}

        {/* Confirmed Matches Section */}
        {confirmedMatches.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <h2
              style={{
                margin: 0,
                fontSize: "14px",
                fontFamily: "var(--rm-font-display)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--rm-route-green)",
              }}
            >
              ✓ Confirmed Rides & Active Chats ({confirmedMatches.length})
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {confirmedMatches.map((m) => (
                <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <MatchCard
                    candidateDisplayName={m.candidateDisplayName}
                    candidateSectorFrom={m.candidateSectorFrom}
                    candidateSectorTo={m.candidateSectorTo}
                    overlapPct={m.overlapPct}
                    detourAddedMinutes={m.detourAddedMinutes}
                    legs={m.legs}
                    routeGeometry={m.routeGeometry}
                    matchType={m.matchType}
                    ownerUserId={m.ownerUserId}
                    vehicleType={m.vehicleType}
                    sharedFarePkr={m.sharedFarePkr}
                    sharedFareNote={m.sharedFareNote}
                    ownerVehicleDeclared={m.ownerVehicleDeclared}
                    ownerVehiclePlate={m.ownerVehiclePlate}
                    ownerVehicleMakeModel={m.ownerVehicleMakeModel}
                    fareSplit={m.fareSplit}
                    currentUserId={currentUserId || "user-current"}
                    status="confirmed"
                    candidateUserId={m.candidateUserId}
                    candidateIsVerified={m.candidateIsVerified}
                    candidateVerifiedDomain={m.candidateVerifiedDomain}
                    candidateRating={m.candidateRating}
                    candidatePreference={m.candidatePreference}
                    safety={
                      currentUserId && m.candidateUserId
                        ? {
                            reporterId: currentUserId,
                            rideId: m.rideId ?? null,
                            onBlocked: () => handleBlocked(m.candidateUserId),
                          }
                        : undefined
                    }
                    onAccept={() => {}}
                    onReject={() => {}}
                    onOpenChat={() => openChatForMatch(m)}
                  />
                  <button
                    type="button"
                    onClick={() => handleCompleteTrip(m)}
                    style={{
                      alignSelf: "flex-end",
                      padding: "7px 12px",
                      fontFamily: "var(--rm-font-display)",
                      fontSize: "11px",
                      fontWeight: 600,
                      letterSpacing: "0.03em",
                      textTransform: "uppercase",
                      color: "var(--rm-route-green)",
                      background: "transparent",
                      border: "1px solid var(--rm-route-green)",
                      borderRadius: "8px",
                      cursor: "pointer",
                    }}
                  >
                    ✓ Arrived — complete trip & rate
                  </button>
                </div>
              ))}

              {/* Day 7 Feature 2: emergency contacts, editable any time a trip is active */}
              {currentUserId && <EmergencyContactsSection userId={currentUserId} />}
              {currentUserId && <VehicleDeclarationSection userId={currentUserId} />}
            </div>
          </section>
        )}

        {/* Dynamic Match Section */}
        {searched && (
          <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {demoNotice && (
              <div
                style={{
                  fontSize: "12px",
                  background: "var(--rm-paper-raised)",
                  border: "1px dashed var(--rm-border)",
                  borderRadius: "8px",
                  padding: "8px 12px",
                  color: "var(--rm-ink-soft)",
                }}
              >
                {demoNotice}
              </div>
            )}
            {safetyNotice && (
              <div
                style={{
                  fontSize: "12px",
                  background: "var(--rm-alert-tint)",
                  border: "1px dashed var(--rm-alert)",
                  borderRadius: "8px",
                  padding: "8px 12px",
                  color: "var(--rm-ink)",
                }}
              >
                🛡️ {safetyNotice}
              </div>
            )}
            {carbonNotice && (
              <div
                style={{
                  fontSize: "12px",
                  background: "#eef7ee",
                  border: "1px dashed #4a8f5c",
                  borderRadius: "8px",
                  padding: "8px 12px",
                  color: "#1f4d2c",
                }}
              >
                {carbonNotice}
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <div>
                <h2
                  style={{
                    margin: 0,
                    fontSize: "14px",
                    fontFamily: "var(--rm-font-display)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--rm-ink-soft)",
                  }}
                >
                  Available Ride Matches
                </h2>
                {searchCriteria && (
                  <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", marginTop: "2px" }}>
                    {searchCriteria.origin.address_label.split(",")[0]} →{" "}
                    {searchCriteria.destination.address_label.split(",")[0]}
                  </div>
                )}
              </div>

              {searchCriteria && (
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: "11px",
                      fontFamily: "var(--rm-font-display)",
                      fontWeight: 600,
                      background: "var(--rm-paper-raised)",
                      border: "1px solid var(--rm-border)",
                      padding: "4px 8px",
                      borderRadius: "6px",
                      color: "var(--rm-ink)",
                    }}
                  >
                    ⏰ {searchCriteria.departureTime} (
                    {searchCriteria.flexibilityMinutes > 0
                      ? `±${searchCriteria.flexibilityMinutes}m`
                      : "Exact"}
                    )
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontFamily: "var(--rm-font-display)",
                      fontWeight: 600,
                      background: "var(--rm-paper-raised)",
                      border: "1px solid var(--rm-border)",
                      padding: "4px 8px",
                      borderRadius: "6px",
                      color: "var(--rm-ink)",
                    }}
                  >
                    👥 Cap:{" "}
                    {searchCriteria.maxCoPassengers === 0
                      ? "Solo Only"
                      : searchCriteria.maxCoPassengers === -1
                      ? "No Limit"
                      : `Max ${searchCriteria.maxCoPassengers}`}
                  </span>
                </div>
              )}
            </div>

            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <MatchCardSkeleton />
                <MatchCardSkeleton />
              </div>
            ) : matches.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {matches.map((m) => (
                  <MatchCard
                    key={m.id}
                    candidateDisplayName={m.candidateDisplayName}
                    candidateSectorFrom={m.candidateSectorFrom}
                    candidateSectorTo={m.candidateSectorTo}
                    overlapPct={m.overlapPct}
                    detourAddedMinutes={m.detourAddedMinutes}
                    legs={m.legs}
                    routeGeometry={m.routeGeometry}
                    matchType={m.matchType}
                    ownerUserId={m.ownerUserId}
                    vehicleType={m.vehicleType}
                    sharedFarePkr={m.sharedFarePkr}
                    sharedFareNote={m.sharedFareNote}
                    ownerVehicleDeclared={m.ownerVehicleDeclared}
                    ownerVehiclePlate={m.ownerVehiclePlate}
                    ownerVehicleMakeModel={m.ownerVehicleMakeModel}
                    fareSplit={m.fareSplit}
                    currentUserId={currentUserId || "user-current"}
                    status={m.status}
                    candidateUserId={m.candidateUserId}
                    candidateIsVerified={m.candidateIsVerified}
                    candidateVerifiedDomain={m.candidateVerifiedDomain}
                    candidateRating={m.candidateRating}
                    candidatePreference={m.candidatePreference}
                    safety={
                      currentUserId && m.candidateUserId
                        ? {
                            reporterId: currentUserId,
                            onBlocked: () => handleBlocked(m.candidateUserId),
                          }
                        : undefined
                    }
                    onAccept={() => handleAccept(m.id)}
                    onReject={() => handleReject(m.id)}
                  />
                ))}

                <FareComparisonCard
                  routesyncPrice={activeUserFare}
                  soloEstimates={soloEstimates.length > 0 ? soloEstimates : DEMO_SOLO_ESTIMATES}
                  estimatesAreLive={soloEstimates.length > 0}
                  sharedDistanceKm={
                    matches[0]?.legs?.find((l) => l.name === "shared_overlap")
                      ? Math.round(matches[0].legs.find((l) => l.name === "shared_overlap")!.distance_m / 100) / 10
                      : 8.5
                  }
                />
              </div>
            ) : (
              <div
                style={{
                  background: "var(--rm-paper-raised)",
                  border: "1.5px dashed var(--rm-border)",
                  borderRadius: "calc(var(--rm-radius) + 4px)",
                  padding: "32px 24px",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <div style={{ fontSize: "28px" }}>🗺️</div>
                <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--rm-ink)" }}>
                  No rides found matching your route and time window.
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: "13px",
                    color: "var(--rm-ink-soft)",
                    maxWidth: "380px",
                    lineHeight: "1.5",
                  }}
                >
                  Nobody is currently travelling this corridor at your departure time. Try
                  widening your time window or adjusting your pickup/drop-off points.
                </p>
              </div>
            )}
          </section>
        )}
      </main>

      {/* Personal dashboard */}
      {dashboardOpen && currentUserId && (
        <UserDashboard
          userId={currentUserId}
          fallbackProfile={
            userProfile
              ? {
                  display_name: userProfile.display_name,
                  gender: userProfile.gender,
                  is_verified: userProfile.is_verified,
                  verified_domain: userProfile.verified_domain,
                }
              : null
          }
          onClose={() => setDashboardOpen(false)}
        />
      )}

      {/* Live Chat Drawer Modal */}
      {activeChatMatch && (
        <MatchChatDrawer
          match={activeChatMatch}
          onClose={() => setActiveChatMatch(null)}
          currentUserId={currentUserId}
          candidateUserId={
            confirmedMatches.find((m) => m.id === activeChatMatch.id || m.chatId === activeChatMatch.chatId)
              ?.candidateUserId
          }
          candidateIsVerified={
            confirmedMatches.find((m) => m.id === activeChatMatch.id || m.chatId === activeChatMatch.chatId)
              ?.candidateIsVerified
          }
          candidateVerifiedDomain={
            confirmedMatches.find((m) => m.id === activeChatMatch.id || m.chatId === activeChatMatch.chatId)
              ?.candidateVerifiedDomain ?? null
          }
          safety={
            currentUserId
              ? {
                  reporterId: currentUserId,
                  rideId:
                    confirmedMatches.find(
                      (m) => m.id === activeChatMatch.id || m.chatId === activeChatMatch.chatId
                    )?.rideId ?? null,
                  onBlocked: () =>
                    handleBlocked(
                      confirmedMatches.find(
                        (m) => m.id === activeChatMatch.id || m.chatId === activeChatMatch.chatId
                      )?.candidateUserId
                    ),
                }
              : undefined
          }
        />
      )}

      {/* Day 7 Feature 2: persistent SOS while a trip is active */}
      {currentUserId && confirmedMatches.length > 0 && (
        <SosButton
          userId={currentUserId}
          tripRequestId={activeTripRequestId}
          rideId={confirmedMatches[0]?.rideId ?? null}
          companionName={confirmedMatches[0]?.candidateDisplayName ?? null}
        />
      )}

      {/* Day 7 Feature 4: post-trip rating prompts, one rider at a time */}
      {ratingQueue.length > 0 && (
        <RatingModal
          rideId={ratingQueue[0].rideId}
          raterId={currentUserId}
          ratedUserId={ratingQueue[0].userId}
          ratedDisplayName={ratingQueue[0].displayName}
          onClose={() => setRatingQueue((q) => q.slice(1))}
          onRated={() => undefined}
        />
      )}
    </div>
  );
}