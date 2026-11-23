import { distanceMeters } from '../../src/utils/geo';

type LatLng = { lat: number; lng: number };

// OSRM sends the road as a compressed string ("polyline", 5 decimals):
// each number is the difference from the previous point, cut into 5-bit chunks.
function decodePolyline(encoded: string): LatLng[] {
    const points: LatLng[] = [];
    let i = 0;
    let lat = 0;
    let lng = 0;

    function nextDifference(): number {
        let value = 0;
        let shift = 0;
        let chunk: number;
        do {
            chunk = encoded.charCodeAt(i++) - 63;
            value |= (chunk & 0x1f) << shift;
            shift += 5;
        } while (chunk >= 0x20);
      return value & 1 ? ~(value >> 1) : value >> 1; // the last bit is the sign
    }

    while (i < encoded.length) {
        lat += nextDifference();
        lng += nextDifference();
        points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
}

// Walks `meters` along the path. Returns where we are and what is left of the path.
function moveAlong(from: LatLng, path: LatLng[], meters: number): {position: LatLng; remaining: LatLng[]} {
    let position = from;
    let left = meters;

    for (let i = 0; i < path.length; i++) {
        const step = distanceMeters(position, path[i]);
        if (step > left) {
            const part = left / step;
            return {
                position: {
                    lat: position.lat + (path[i].lat - position.lat) * part,
                    lng: position.lng + (path[i].lng - position.lng) * part
                },
                remaining: path.slice(i)
            };
        }
        left -= step;
        position = path[i];
    }
    return { position, remaining: [] };
}

// A random point between minM and maxM meters from the center, in a random direction.
// Small distances only: the earth is treated as flat (a few cm of error at 2 km).
function randomPointNear(center: LatLng, minM: number, maxM: number): LatLng {
    const meters = minM + Math.random() * (maxM - minM);
    const angle = Math.random() * 2 * Math.PI; // 0 = north, PI/2 = east
    const metersPerDegreeLat = 111_320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos((center.lat * Math.PI) / 180);
    return {
        lat: center.lat + (meters * Math.cos(angle)) / metersPerDegreeLat,
        lng: center.lng + (meters * Math.sin(angle)) / metersPerDegreeLng
    };
}

export { decodePolyline, moveAlong, randomPointNear };
export type { LatLng };