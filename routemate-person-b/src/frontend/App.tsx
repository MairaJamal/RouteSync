import { useEffect, useRef, useState } from "react";
import LocationSearchForm, { TripSearchValue, UserRole } from "./LocationSearchForm";
import { authedFetch, restoreSession, signOut, rememberPreferredRole, AuthUserSession } from "./demoAuth";
import AuthScreen from "./AuthScreen";
import UserDashboard from "./UserDashboard";
import MatchCard, { MatchCardSkeleton } from "./MatchCard";
import FareComparisonCard, { SoloFareEstimateView } from "./FareComparisonCard";
import MatchChatDrawer, { ConfirmedMatchInfo } from "./MatchChatDrawer";
import PendingConsentsPanel from "./PendingConsentsPanel";
import MatchRequestsPanel, {
  SendRequestModal,
  MatchRequestView,
  SendRequestValues,
} from "./matchrequestflow";
import SharedRideBrowser from "./SharedRideBrowser";
import NotificationBell from "./NotificationBell";
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
  /** Group carpool: candidate hosts this trip; members are riders
   *  already confirmed into the car. Null for plain 1:1 matches. */
  group?: {
    hostUserId: string;
    hostDisplayName: string;
    /** Real trip id for live matches; absent on offline mock matches. */
    hostTripRequestId?: string;
    members: { userId: string; displayName: string }[];
    pendingMembers?: { userId: string; displayName: string }[];
  } | null;
  status: "pending" | "confirmed";
  rideId?: string;
  /** Live chat thread id after Accept (shared with the other user). */
  chatId?: string;
  /** The ride's real status, read from the server on every poll. A chat
   *  thread outlives the ride it was opened for, so the card has to be
   *  labelled from the ride — otherwise a finished trip keeps offering
   *  "Arrived — complete trip & rate" to everyone who was on it. */
  rideStatus?: string | null;
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
  // Chats the rider has manually archived (or completed). Persisted per
  // user in localStorage so the 4s /match-chats poll — which re-adds every
  // server-side thread — can't resurrect ones they've cleared from the
  // "looking for rides" view. A ref (not state) keeps the poll closure
  // reading the live value without re-creating its interval.
  const archivedChatIdsRef = useRef<Set<string>>(new Set());
  const [searchCriteria, setSearchCriteria] = useState<TripSearchValue | null>(null);
  const [activeChatMatch, setActiveChatMatch] = useState<ConfirmedMatchInfo | null>(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [demoPreviewOpen, setDemoPreviewOpen] = useState(false);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);
  const [soloEstimates, setSoloEstimates] = useState<SoloFareEstimateView[]>([]);

  // Day 7 state
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [activeTripRequestId, setActiveTripRequestId] = useState<string | null>(null);
  const [ratingQueue, setRatingQueue] = useState<PendingRating[]>([]);
  const [safetyNotice, setSafetyNotice] = useState<string | null>(null);
  const [carbonNotice, setCarbonNotice] = useState<string | null>(null);

  // Two-sided approval state: "Accept" now sends a request instead of
  // confirming. outgoingRequests mirrors the panel's poll so match
  // cards can show "request sent" without polling twice themselves.
  const [outgoingRequests, setOutgoingRequests] = useState<MatchRequestView[]>([]);
  const [requestMatchId, setRequestMatchId] = useState<string | null>(null);
  const [sendingRequest, setSendingRequest] = useState(false);
  const [sendRequestError, setSendRequestError] = useState<string | null>(null);

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

  // Load this user's archived chats once their id is known, and prune any
  // already-rendered cards archived in a previous session.
  useEffect(() => {
    if (!currentUserId) {
      archivedChatIdsRef.current = new Set();
      return;
    }
    try {
      const raw = localStorage.getItem(`rm_archived_chats_${currentUserId}`);
      archivedChatIdsRef.current = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      archivedChatIdsRef.current = new Set();
    }
    setConfirmedMatches((prev) =>
      prev.filter((m) => !isArchived(m.chatId) && !isArchived(m.id))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  function isArchived(key: string | undefined): boolean {
    return !!key && archivedChatIdsRef.current.has(key);
  }

  /** Hide a confirmed chat from the active view and remember it, so the
   *  background /match-chats poll won't bring it back. Used by the Archive
   *  button and by trip completion. */
  function archiveChat(chatId: string | undefined, id?: string) {
    if (chatId) archivedChatIdsRef.current.add(chatId);
    if (id) archivedChatIdsRef.current.add(id);
    if (currentUserId) {
      try {
        localStorage.setItem(
          `rm_archived_chats_${currentUserId}`,
          JSON.stringify([...archivedChatIdsRef.current])
        );
      } catch {
        /* storage blocked — the in-session hide below still works */
      }
    }
    setConfirmedMatches((prev) => prev.filter((m) => !isArchived(m.chatId) && !isArchived(m.id)));
    setActiveChatMatch((cur) =>
      cur && (isArchived(cur.chatId) || isArchived(cur.id)) ? null : cur
    );
  }

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
          /** live ride state from the server: active | full | completed | cancelled */
          ride_status?: string | null;
          created_at?: string | null;
        }>;
        if (!inbound.length || cancelled) return;

        setConfirmedMatches((prev) => {
          const existingChatIds = new Set(prev.filter((m) => m.chatId).map((m) => m.chatId!));
          // Chats from previous calendar days are treated as finished test
          // data — hide them from the active view automatically. Anything
          // created today (including fresh demo matches) always stays.
          const startOfToday = new Date();
          startOfToday.setHours(0, 0, 0, 0);
          let next = prev.map((m) => ({ ...m }));
          for (const c of inbound) {
            const idx = next.findIndex(
              (m) =>
                m.chatId === c.chat_id ||
                (m.candidateUserId === c.peer_user_id && m.status === "confirmed")
            );
            if (idx >= 0) {
              // Already on screen — but still refresh what the server now
              // knows. A ride the OTHER person completed has to reach this
              // card, or it keeps offering to complete a trip that is over.
              next[idx] = {
                ...next[idx],
                chatId: c.chat_id,
                rideId: next[idx].rideId ?? (c.ride_id ?? undefined),
                rideStatus: c.ride_status ?? next[idx].rideStatus,
              };
              existingChatIds.add(c.chat_id);
              continue;
            }
            // Respect manual archives/completions — the server keeps the
            // thread, but the rider cleared it from their active view.
            if (archivedChatIdsRef.current.has(c.chat_id)) continue;
            if (c.created_at && new Date(c.created_at).getTime() < startOfToday.getTime()) continue;
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
                rideStatus: c.ride_status ?? null,
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
    return (
      <>
        <AuthScreen onSuccess={setAuthSession} onPreview={() => setDemoPreviewOpen(true)} />
        {demoPreviewOpen && (
          <UserDashboard
            userId="demo-preview"
            demoPreview
            fallbackProfile={{
              display_name: "RouteSync Demo",
              gender: "female",
              is_verified: true,
              verified_domain: "demo.routesync",
            }}
            onClose={() => setDemoPreviewOpen(false)}
          />
        )}
      </>
    );
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
      const [hh, mm] = val.departureTime.split(":").map((n) => Number(n));
      const departureAt = new Date();
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        departureAt.setHours(hh, mm, 0, 0);
        // A clock time that has already gone means tomorrow, not the past.
        // Two people on one corridor, searched minutes apart across
        // midnight, were otherwise stamped ~16 hours from each other and
        // the departure-window check never let them match.
        if (departureAt.getTime() < Date.now()) departureAt.setDate(departureAt.getDate() + 1);
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
        // vehicle_type is the ONLY role signal the matcher has, so the chosen
        // role decides it: an "Offering a Ride" search can never be recorded
        // as a passenger search (which would hide the offer from everyone).
        vehicle_type:
          val.userRole === "OFFERING"
            ? val.vehicleType === "bike"
              ? "bike"
              : "car"
            : (val.vehicleType ?? "none"),
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

      // A posted ride has to be findable by somebody else. The trip request
      // above makes it matchable; this lists it as a car under "Join an
      // existing shared ride", so a rider in the same area sees it even when
      // their search isn't an exact copy. Best-effort on purpose: if it fails
      // the offer is still matchable, so it is reported rather than fatal.
      if (val.userRole === "OFFERING") {
        const seats = val.seatsAvailable ?? 2;
        try {
          const carRes = await authedFetch(`${API_URL}/api/rides`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              driver_id: currentUserId,
              origin: val.origin,
              destination: val.destination,
              departure_time: departureAt.toISOString(),
              total_seats: seats,
              driver_max_co_passengers: seats - 1,
            }),
          });
          if (carRes.status !== 503 && !carRes.ok) {
            const body = await carRes.json().catch(() => null);
            setSafetyNotice(
              `Your ride is being matched, but it isn't listed under "Join an existing shared ride" yet: ${
                body?.details ?? body?.error ?? "unknown error"
              }.`
            );
          }
        } catch {
          setSafetyNotice(
            "Your ride is being matched, but we couldn't reach the server to list it under 'Join an existing shared ride'."
          );
        }
      }

      // Vehicle details are a trust add-on that sits ON TOP of an offer, not
      // a precondition for it. This runs after the trip request exists and
      // never throws: an account with no CNIC on file still gets a live,
      // discoverable offer, plus an honest note about what is missing.
      // (Before this, a 400 here aborted the whole search and silently lost
      // the driver's offer — the other account then saw nothing at all.)
      if (val.vehicleDeclaration) {
        const vehBody: Record<string, string> = {
          vehicle_plate: val.vehicleDeclaration.plate,
          vehicle_make_model: val.vehicleDeclaration.makeModel,
        };
        if (val.vehicleDeclaration.cnic) {
          vehBody.cnic_number = val.vehicleDeclaration.cnic;
        }
        try {
          const vehRes = await authedFetch(`${API_URL}/api/users/${currentUserId}/vehicle-declaration`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(vehBody),
          });
          if (vehRes.status !== 503 && !vehRes.ok) {
            const body = await vehRes.json().catch(() => null);
            setSafetyNotice(
              body?.error === "INVALID_CNIC"
                ? "Your ride is being offered, but your vehicle details weren't saved — a CNIC is required for that. Type it once in the 'CNIC' field under Vehicle details and search again to attach them."
                : `Your ride is being offered, but the vehicle declaration failed: ${
                    body?.details ?? body?.error ?? "unknown error"
                  }. Riders see your offer without the declared-vehicle badge until that is fixed.`
            );
          }
        } catch {
          setSafetyNotice(
            "Your ride is being offered, but we couldn't reach the server to save your vehicle details."
          );
        }
      }

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
        group: m.group
          ? {
              hostUserId: m.group.host_user_id,
              hostDisplayName: m.group.host_display_name,
              hostTripRequestId: m.group.host_trip_request_id,
              members: (m.group.members ?? []).map((x: any) => ({
                userId: x.user_id,
                displayName: x.display_name,
              })),
              pendingMembers: (m.group.pending_members ?? []).map((x: any) => ({
                userId: x.user_id,
                displayName: x.display_name,
              })),
            }
          : null,
        status: "pending",
      }));

      setMatches(liveMatches);
      setSoloEstimates(payload.solo_fare_estimates ?? []);
      // Role stickiness: searching as a driver (or passenger) is remembered
      // on the account, so the next reload doesn't silently flip the form
      // back to "Looking for a Ride" and demote an active offer.
      if (authSession && val.userRole !== authSession.preferredRole) {
        setAuthSession({ ...authSession, preferredRole: val.userRole });
        void rememberPreferredRole(val.userRole);
      }
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

  /** Two-sided approval: "Send Request" only opens the modal — nothing
   *  is confirmed, and no chat exists, until both riders approve. */
  function handleAccept(id: string) {
    setSendRequestError(null);
    setRequestMatchId(id);
  }

  async function submitMatchRequest(values: SendRequestValues) {
    const match = matches.find((m) => m.id === requestMatchId);
    if (!match || !match.candidateUserId || !searchCriteria || !currentUserId) return;

    const [hh, mm] = searchCriteria.departureTime.split(":").map(Number);
    const dep = new Date();
    if (Number.isFinite(hh) && Number.isFinite(mm)) dep.setHours(hh, mm, 0, 0);

    const myShare =
      match.fareSplit.find((f) => f.user_id === currentUserId)?.total_fare ??
      match.fareSplit[0]?.total_fare ??
      0;
    const peerShare =
      match.fareSplit.find((f) => f.user_id === match.candidateUserId)?.total_fare ?? myShare;

    setSendingRequest(true);
    setSendRequestError(null);
    try {
      const res = await authedFetch(`${API_URL}/api/match-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_user_id: currentUserId,
          to_user_id: match.candidateUserId,
          from_trip_request_id: activeTripRequestId,
          to_trip_request_id: match.id,
          // Tell the server this request joins the candidate's hosted car
          // so the handshake + chat are tracked as multi-party group state.
          group: match.group
            ? {
                host_user_id: match.group.hostUserId,
                host_trip_request_id: match.group.hostTripRequestId ?? match.id,
              }
            : undefined,
          preferences: {
            gender_preference: values.genderPreference,
            departure_time: dep.toISOString(),
            flexibility_minutes: values.flexibilityMinutes,
            max_co_passengers: values.maxCoPassengers,
            vehicle_type: searchCriteria.vehicleType ?? "none",
            pickup_note: values.pickupNote,
            note: values.note,
          },
          snapshot: {
            origin_label: searchCriteria.origin.address_label,
            destination_label: searchCriteria.destination.address_label,
            origin: searchCriteria.origin,
            destination: searchCriteria.destination,
            overlap_pct: match.overlapPct,
            detour_added_minutes: match.detourAddedMinutes,
            match_type: match.matchType ?? "peer_share",
            fare_share_from_pkr: myShare,
            fare_share_to_pkr: peerShare,
          },
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        // 409 REQUEST_ALREADY_OPEN etc. — the server's message explains
        // whose open request is in the way, so show it in the modal.
        setSendRequestError(
          payload?.details ?? payload?.error ?? `Could not send the request (${res.status}).`
        );
        return;
      }
      setRequestMatchId(null);
      const sent = payload.request as MatchRequestView;
      setOutgoingRequests((prev) => [sent, ...prev.filter((o) => o.id !== sent.id)]);
      setDemoNotice(
        match.group
          ? `Join request sent to ${match.candidateDisplayName}'s group — nothing is confirmed until they accept and you give the final OK.`
          : `Request sent to ${match.candidateDisplayName} — nothing is confirmed until they accept and you give the final OK.`
      );
    } catch (err: any) {
      setSendRequestError(
        `Network error — request not sent: ${err instanceof Error ? err.message : "unknown error"}`
      );
    } finally {
      setSendingRequest(false);
    }
  }

  /** Runs ONLY after the requester gives the final OK on the recipient's
   *  conditions — the server already opened the chat in finalize; this
   *  attaches the ride id to that thread and moves the pair into
   *  "Confirmed Rides". */
  async function handleRequestConfirmed(
    request: MatchRequestView,
    chatId: string,
    serverRideId?: string | null
  ) {
    const peerId = request.peer_user_id;
    const srcMatch = matches.find((m) => m.candidateUserId === peerId);
    setMatches((prev) => prev.filter((m) => m.candidateUserId !== peerId));

    // The ride row belongs to the CAR, and finalize resolves it server-side:
    // one row per car, owned by whoever hosts it, with each confirmed rider
    // booked onto it. Minting a row here per confirmation is what made one
    // carpool show up as several "rides" — and turned a passenger who
    // pressed OK last into a phantom driver in ride discovery. Only create
    // one as a fallback, and only when this user is the host.
    let rideId: string | undefined = serverRideId ?? undefined;
    const hostUserId = request.group?.host_user_id ?? currentUserId;
    if (!rideId && currentUserId && hostUserId === currentUserId) {
      try {
        const res = await authedFetch(`${API_URL}/api/rides`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driver_id: currentUserId,
            origin: request.snapshot.origin,
            destination: request.snapshot.destination,
            departure_time: request.preferences.departure_time,
          }),
        });
        if (res.status === 201) {
          rideId = (await res.json()).ride_id;
        } else if (res.status === 503) {
          setSafetyNotice("Ride confirmed — post-trip ratings need the Day 7 database migration first.");
        }
      } catch {
        // Ride creation is best-effort; the confirmation stands.
      }
    }

    // Now allowed by the approval gate (the request is confirmed) — this
    // upserts the SAME thread finalize created, adding the ride id.
    if (rideId && currentUserId) {
      try {
        await authedFetch(`${API_URL}/api/match-chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            my_user_id: currentUserId,
            my_display_name: userProfile?.display_name ?? "You",
            peer_user_id: peerId,
            peer_display_name: request.peer_name,
            origin_label: request.snapshot.origin_label,
            destination_label: request.snapshot.destination_label,
            fare_share_pkr: request.snapshot.fare_share_from_pkr,
            ride_id: rideId,
          }),
        });
      } catch {
        // Ride id attachment is best-effort too — chat already exists.
      }
    }

    const fareSharePKR = request.snapshot.fare_share_from_pkr ?? 0;
    setConfirmedMatches((prev) => {
      // De-dup by chatId AND peer so the 4s /match-chats poll (which
      // picks the same thread up from the server side) can't double-add.
      if (prev.some((m) => m.chatId === chatId || (peerId && m.candidateUserId === peerId && m.status === "confirmed"))) {
        return prev.map((m) => (m.chatId === chatId || m.candidateUserId === peerId ? { ...m, chatId, rideId: rideId ?? m.rideId } : m));
      }
      const confirmed: MatchItem = {
        id: chatId,
        chatId,
        rideId,
        candidateDisplayName: request.peer_name,
        candidateUserId: peerId,
        candidatePhone: "Use in-app chat",
        candidateSectorFrom: request.snapshot.origin_label,
        candidateSectorTo: request.snapshot.destination_label,
        candidateIsVerified: srcMatch?.candidateIsVerified,
        candidateVerifiedDomain: srcMatch?.candidateVerifiedDomain ?? null,
        candidateRating: srcMatch?.candidateRating ?? null,
        candidatePreference: srcMatch?.candidatePreference,
        overlapPct: request.snapshot.overlap_pct,
        detourAddedMinutes: request.snapshot.detour_added_minutes,
        legs: srcMatch?.legs ?? [],
        routeGeometry: srcMatch?.routeGeometry,
        fareSplit: [
          { user_id: currentUserId, total_fare: request.snapshot.fare_share_from_pkr },
          { user_id: peerId, total_fare: request.snapshot.fare_share_to_pkr },
        ],
        matchType: request.snapshot.match_type,
        status: "confirmed",
      };
      return [confirmed, ...prev];
    });

    const sharedDistanceKm = srcMatch?.legs?.find((l) => l.name === "shared_overlap")
      ? Math.round(srcMatch.legs.find((l) => l.name === "shared_overlap")!.distance_m / 100) / 10
      : 8.5;
    const riderCount = 2;
    const carbonSummary = co2SavedSummary(sharedDistanceKm, riderCount);
    if (carbonSummary) setCarbonNotice(carbonSummary);

    setActiveChatMatch({
      id: chatId,
      chatId,
      candidateDisplayName: request.peer_name,
      candidatePhone: "Use in-app chat",
      candidateSectorFrom: request.snapshot.origin_label,
      candidateSectorTo: request.snapshot.destination_label,
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
      // Archive so the 4s poll doesn't resurrect the just-completed ride.
      archiveChat(matchItem.chatId, matchItem.id);
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

  /** MatchCard status box: an open outgoing request to this candidate, if any. */
  function openRequestStatusFor(candidateUserId?: string): "pending" | "awaiting_requester" | null {
    if (!candidateUserId) return null;
    const o = outgoingRequests.find((x) => x.peer_user_id === candidateUserId);
    if (o && (o.status === "pending" || o.status === "awaiting_requester")) return o.status;
    return null;
  }

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
          <LocationSearchForm
            onSubmit={handleSearch}
            currentUserGender={userProfile?.gender}
            initialUserRole={preferredRole}
          />
        </section>

        {/* Two-sided approval: ride requests awaiting my answer, and my
            own requests awaiting the other side. Sits above the consent
            votes — both are "someone is waiting on you" panels. */}
        {currentUserId && (
          <MatchRequestsPanel
            userId={currentUserId}
            onOutgoingChange={setOutgoingRequests}
            onConfirmed={handleRequestConfirmed}
          />
        )}

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
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={() => archiveChat(m.chatId, m.id)}
                      title="Hide this chat from your active rides"
                      style={{
                        padding: "7px 12px",
                        fontFamily: "var(--rm-font-display)",
                        fontSize: "11px",
                        fontWeight: 600,
                        letterSpacing: "0.03em",
                        textTransform: "uppercase",
                        color: "var(--rm-ink-soft)",
                        background: "transparent",
                        border: "1px solid var(--rm-border)",
                        borderRadius: "8px",
                        cursor: "pointer",
                      }}
                    >
                      ⤓ Archive
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCompleteTrip(m)}
                      title={
                        m.rideStatus === "completed"
                          ? "This ride is already finished — rate who you rode with, then it leaves your active list"
                          : "Mark the trip arrived, then rate your co-riders"
                      }
                      style={{
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
                      {m.rideStatus === "completed"
                        ? "✓ Ride completed — rate your trip"
                        : "✓ Arrived — complete trip & rate"}
                    </button>
                  </div>
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
                    group={m.group ?? null}
                    safety={
                      currentUserId && m.candidateUserId
                        ? {
                            reporterId: currentUserId,
                            onBlocked: () => handleBlocked(m.candidateUserId),
                          }
                        : undefined
                    }
                    requestStatus={openRequestStatusFor(m.candidateUserId)}
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

      {/* Two-sided approval: the request composer for one match card */}
      {requestMatchId !== null &&
        (() => {
          const m = matches.find((x) => x.id === requestMatchId);
          if (!m) return null;
          const myShare =
            m.fareSplit.find((f) => f.user_id === currentUserId)?.total_fare ??
            m.fareSplit[0]?.total_fare ??
            0;
          return (
            <SendRequestModal
              peerName={m.candidateDisplayName}
              groupInfo={
                m.group
                  ? {
                      hostName: m.group.hostDisplayName,
                      memberNames: m.group.members.map((x) => x.displayName),
                    }
                  : undefined
              }
              originLabel={searchCriteria?.origin.address_label ?? m.candidateSectorFrom}
              destinationLabel={searchCriteria?.destination.address_label ?? m.candidateSectorTo}
              departureTime={searchCriteria?.departureTime ?? "--:--"}
              myFareSharePkr={myShare}
              submitting={sendingRequest}
              error={sendRequestError}
              onSubmit={submitMatchRequest}
              onCancel={() => {
                setRequestMatchId(null);
                setSendRequestError(null);
              }}
            />
          );
        })()}

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

      {/* Day 7 Feature 2: persistent SOS — always available while logged
          in, not only during a confirmed ride. SosButton already handles
          a null ride/companion with its manual fallback flow. */}
      {currentUserId && (
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

