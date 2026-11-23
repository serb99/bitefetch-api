type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;

// Straight line between two points
function distanceMeters(a: LatLng, b: LatLng): number {
    const rad = (degrees: number): number => (degrees * Math.PI) / 180;
    const h =
        Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export { distanceMeters };