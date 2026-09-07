/* Changed: Interactive Leaflet map component supporting pickup/drop-off point selection, real-time reverse geocoding via Photon, and route vector visualization. */
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { LocationPoint } from "../types";
import {
  reverseGeocode,
  PlaceSuggestion,
  isWithinServiceArea,
  SERVICE_AREA_BOUNDS,
  SERVICE_AREA_LABEL,
} from "./places";

interface InteractiveMapPickerProps {
  activeMode: "pickup" | "dropoff" | null;
  pickupPoint: LocationPoint | null;
  dropoffPoint: LocationPoint | null;
  onSelectPoint: (mode: "pickup" | "dropoff", suggestion: PlaceSuggestion) => void;
  onClose?: () => void;
}

export default function InteractiveMapPicker({
  activeMode,
  pickupPoint,
  dropoffPoint,
  onSelectPoint,
  onClose,
}: InteractiveMapPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pickupMarkerRef = useRef<L.Marker | null>(null);
  const dropoffMarkerRef = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);

  const [currentMode, setCurrentMode] = useState<"pickup" | "dropoff">(activeMode || "pickup");
  const [loading, setLoading] = useState(false);
  const [lastSelectedText, setLastSelectedText] = useState<string | null>(null);
  const [outOfRegion, setOutOfRegion] = useState(false);

  useEffect(() => {
    if (activeMode) setCurrentMode(activeMode);
  }, [activeMode]);

  // Initialize Map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Centered on Islamabad
    const map = L.map(containerRef.current, {
      center: [33.6844, 73.0479],
      zoom: 13,
      zoomControl: true,
      attributionControl: false,
    });

    // High-performance, crisp CartoDB Voyager tiles
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);

    // Operational service-area boundary (Islamabad / Rawalpindi). Drawn so
    // the region restriction is visible before anyone clicks outside it —
    // clicks beyond this rectangle are rejected with an inline warning.
    // Note: Leaflet writes SVG presentation attributes, where CSS custom
    // properties don't resolve, so the green is the literal --rm-route-green
    // hex rather than the var().
    L.rectangle(
      [
        [SERVICE_AREA_BOUNDS.latMin, SERVICE_AREA_BOUNDS.lngMin],
        [SERVICE_AREA_BOUNDS.latMax, SERVICE_AREA_BOUNDS.lngMax],
      ],
      {
        color: "#3d8361",
        weight: 1.5,
        dashArray: "4, 6",
        fillOpacity: 0.03,
        interactive: false,
      }
    ).addTo(map);

    mapRef.current = map;

    // Essential Leaflet fix: recalculate dimensions after DOM paint
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 150);

    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update Markers & Connecting Line
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Custom Icon Creators
    const createCustomIcon = (color: string, label: string) =>
      L.divIcon({
        className: "custom-leaflet-marker",
        html: `
          <div style="
            background: ${color};
            color: #fff;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-family: var(--rm-font-display);
            font-weight: 600;
            white-space: nowrap;
            box-shadow: 0 4px 10px rgba(0,0,0,0.25);
            border: 2px solid white;
            display: flex;
            align-items: center;
            gap: 4px;
          ">
            <span style="width:6px; height:6px; background:#fff; border-radius:50%;"></span>
            ${label}
          </div>
        `,
        iconSize: [80, 30],
        iconAnchor: [40, 15],
      });

    // Pickup Marker
    if (pickupPoint) {
      if (pickupMarkerRef.current) {
        pickupMarkerRef.current.setLatLng([pickupPoint.lat, pickupPoint.lng]);
      } else {
        pickupMarkerRef.current = L.marker([pickupPoint.lat, pickupPoint.lng], {
          icon: createCustomIcon("var(--rm-route-blue)", "Pickup"),
        }).addTo(map);
      }
    } else if (pickupMarkerRef.current) {
      pickupMarkerRef.current.remove();
      pickupMarkerRef.current = null;
    }

    // Dropoff Marker
    if (dropoffPoint) {
      if (dropoffMarkerRef.current) {
        dropoffMarkerRef.current.setLatLng([dropoffPoint.lat, dropoffPoint.lng]);
      } else {
        dropoffMarkerRef.current = L.marker([dropoffPoint.lat, dropoffPoint.lng], {
          icon: createCustomIcon("var(--rm-route-purple)", "Drop-off"),
        }).addTo(map);
      }
    } else if (dropoffMarkerRef.current) {
      dropoffMarkerRef.current.remove();
      dropoffMarkerRef.current = null;
    }

    // Polyline
    if (pickupPoint && dropoffPoint) {
      const latlngs: [number, number][] = [
        [pickupPoint.lat, pickupPoint.lng],
        [dropoffPoint.lat, dropoffPoint.lng],
      ];
      if (lineRef.current) {
        lineRef.current.setLatLngs(latlngs);
      } else {
        lineRef.current = L.polyline(latlngs, {
          color: "var(--rm-route-green)",
          weight: 4,
          dashArray: "6, 8",
          opacity: 0.85,
        }).addTo(map);
      }
      map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
    } else if (lineRef.current) {
      lineRef.current.remove();
      lineRef.current = null;
    }
  }, [pickupPoint, dropoffPoint]);

  // Click Handler for Map Selection
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    async function handleMapClick(e: L.LeafletMouseEvent) {
      const { lat, lng } = e.latlng;
      // Guard before reverse-geocoding: no point resolving an address for a
      // coordinate the matching pipeline would reject as out of region.
      if (!isWithinServiceArea(lat, lng)) {
        setOutOfRegion(true);
        setLastSelectedText(null);
        return;
      }
      setOutOfRegion(false);
      setLoading(true);
      try {
        const suggestion = await reverseGeocode(lat, lng);
        onSelectPoint(currentMode, suggestion);
        setLastSelectedText(`Set ${currentMode} to ${suggestion.label.split(",")[0]}`);
      } catch (err) {
        console.error("Geocoding failed", err);
      } finally {
        setLoading(false);
      }
    }

    map.on("click", handleMapClick);
    return () => {
      map.off("click", handleMapClick);
    };
  }, [currentMode, onSelectPoint]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        background: "var(--rm-paper-raised)",
        border: "1px solid var(--rm-border)",
        borderRadius: "var(--rm-radius)",
        padding: "14px",
        fontFamily: "var(--rm-font-body)",
      }}
    >
      {/* Top Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            type="button"
            onClick={() => setCurrentMode("pickup")}
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              fontFamily: "var(--rm-font-display)",
              fontWeight: 600,
              borderRadius: "6px",
              border: "1px solid var(--rm-border)",
              background: currentMode === "pickup" ? "var(--rm-route-blue)" : "var(--rm-paper)",
              color: currentMode === "pickup" ? "#fff" : "var(--rm-ink)",
              cursor: "pointer",
            }}
          >
            Pin Pickup (Blue)
          </button>

          <button
            type="button"
            onClick={() => setCurrentMode("dropoff")}
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              fontFamily: "var(--rm-font-display)",
              fontWeight: 600,
              borderRadius: "6px",
              border: "1px solid var(--rm-border)",
              background: currentMode === "dropoff" ? "var(--rm-route-purple)" : "var(--rm-paper)",
              color: currentMode === "dropoff" ? "#fff" : "var(--rm-ink)",
              cursor: "pointer",
            }}
          >
            Pin Drop-off (Purple)
          </button>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: "12px",
              fontFamily: "var(--rm-font-display)",
              background: "transparent",
              border: "none",
              color: "var(--rm-ink-soft)",
              cursor: "pointer",
            }}
          >
            Done ✕
          </button>
        )}
      </div>

      {/* Quick Location Chips */}
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)", fontWeight: 600 }}>Quick Pin:</span>
        {[
          { label: "F-10 Markaz", lat: 33.6938, lng: 73.0135, sector: "F-10" },
          { label: "G-9 Markaz", lat: 33.6917, lng: 73.0336, sector: "G-9" },
          { label: "NUST H-12", lat: 33.6425, lng: 72.9930, sector: "H-12" },
          { label: "Blue Area", lat: 33.7100, lng: 73.0650, sector: "G-7" },
          { label: "F-7 Jinnah Super", lat: 33.7200, lng: 73.0550, sector: "F-7" },
        ].map((spot) => (
          <button
            key={spot.label}
            type="button"
            onClick={() => {
              onSelectPoint(currentMode, {
                label: spot.label,
                sectorCode: spot.sector,
                point: { lat: spot.lat, lng: spot.lng, address_label: spot.label },
              });
              setLastSelectedText(`Set ${currentMode} to ${spot.label}`);
              if (mapRef.current) {
                mapRef.current.flyTo([spot.lat, spot.lng], 14, { duration: 0.6 });
              }
            }}
            style={{
              padding: "3px 8px",
              fontSize: "11px",
              fontFamily: "var(--rm-font-display)",
              borderRadius: "999px",
              border: "1px solid var(--rm-border)",
              background: "var(--rm-paper)",
              color: "var(--rm-ink)",
              cursor: "pointer",
            }}
          >
            {spot.label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        <span>
          📍 Click inside the dashed {SERVICE_AREA_LABEL} boundary to set{" "}
          <strong>{currentMode.toUpperCase()}</strong> location.
        </span>
        {loading && <span style={{ color: "var(--rm-route-blue)" }}>Resolving address…</span>}
      </div>

      {outOfRegion && (
        <div
          role="alert"
          style={{
            fontSize: "12px",
            background: "var(--rm-alert-tint)",
            border: "1px dashed var(--rm-alert)",
            borderRadius: "8px",
            padding: "8px 12px",
            color: "var(--rm-ink)",
          }}
        >
          ⚠️ Out of Region: RouteSync is currently only available within {SERVICE_AREA_LABEL}. Pick
          a point inside the dashed boundary.
        </div>
      )}

      {/* Map Container */}
      <div
        ref={containerRef}
        style={{
          height: "320px",
          width: "100%",
          borderRadius: "8px",
          overflow: "hidden",
          border: "1.5px solid var(--rm-border)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
          zIndex: 1,
        }}
      />

      {lastSelectedText && (
        <div style={{ fontSize: "11px", color: "var(--rm-route-green)", fontWeight: 600, fontFamily: "var(--rm-font-display)" }}>
          ✓ {lastSelectedText}
        </div>
      )}
    </div>
  );
}
