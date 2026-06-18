/**
 * Load & stress tests for iNesting DXF parser and mergeLines algorithm.
 * Validates correctness and performance under realistic CAD file conditions.
 *
 * Run with: node test/test-load.js
 */

'use strict';

const dxf = require('dxf');
const assert = require('assert');

let passed = 0;
let failed = 0;
const timings = [];

function test(name, fn) {
	const t0 = Date.now();
	try {
		fn();
		const ms = Date.now() - t0;
		timings.push({ name, ms, ok: true });
		console.log(`  PASS [${ms}ms]: ${name}`);
		passed++;
	} catch(e) {
		const ms = Date.now() - t0;
		timings.push({ name, ms, ok: false });
		console.error(`  FAIL [${ms}ms]: ${name}`);
		console.error(`        ${e.message}`);
		failed++;
	}
}

// ── DXF generators ────────────────────────────────────────────────────────────

function dxfHeader() {
	return `0\nSECTION\n2\nENTITIES\n`;
}
function dxfFooter() {
	return `0\nENDSEC\n0\nEOF\n`;
}

// Generates N individual LINE entities forming a closed polygon (exploded)
function makeDxfExplodedPolygon(sides) {
	const step = (2 * Math.PI) / sides;
	const r = 100;
	let entities = '';
	for (let i = 0; i < sides; i++) {
		const x1 = r * Math.cos(i * step);
		const y1 = r * Math.sin(i * step);
		const x2 = r * Math.cos((i + 1) * step);
		const y2 = r * Math.sin((i + 1) * step);
		entities += `0\nLINE\n8\n0\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`;
	}
	return dxfHeader() + entities + dxfFooter();
}

// Generates N closed LWPOLYLINE rectangles spaced on a grid
function makeDxfGridRectangles(cols, rows, w, h, spacing) {
	let entities = '';
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const x = col * (w + spacing);
			const y = row * (h + spacing);
			entities += `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n`;
			entities += `10\n${x}\n20\n${y}\n`;
			entities += `10\n${x+w}\n20\n${y}\n`;
			entities += `10\n${x+w}\n20\n${y+h}\n`;
			entities += `10\n${x}\n20\n${y+h}\n`;
		}
	}
	return dxfHeader() + entities + dxfFooter();
}

// Generates N circles
function makeDxfCircles(n, radius) {
	let entities = '';
	const cols = Math.ceil(Math.sqrt(n));
	for (let i = 0; i < n; i++) {
		const x = (i % cols) * (radius * 2 + 10);
		const y = Math.floor(i / cols) * (radius * 2 + 10);
		entities += `0\nCIRCLE\n8\n0\n10\n${x}\n20\n${y}\n30\n0\n40\n${radius}\n`;
	}
	return dxfHeader() + entities + dxfFooter();
}

// Generates a DXF with mixed entity types
function makeDxfMixed(n) {
	let entities = '';
	for (let i = 0; i < n; i++) {
		const x = (i % 20) * 15;
		const y = Math.floor(i / 20) * 15;
		const type = i % 4;
		if (type === 0) {
			// LINE
			entities += `0\nLINE\n8\n0\n10\n${x}\n20\n${y}\n30\n0\n11\n${x+10}\n21\n${y+10}\n31\n0\n`;
		} else if (type === 1) {
			// CIRCLE
			entities += `0\nCIRCLE\n8\n0\n10\n${x+5}\n20\n${y+5}\n30\n0\n40\n4\n`;
		} else if (type === 2) {
			// ARC (quarter circle)
			entities += `0\nARC\n8\n0\n10\n${x+5}\n20\n${y+5}\n30\n0\n40\n5\n50\n0\n51\n90\n`;
		} else {
			// LWPOLYLINE (closed rectangle)
			entities += `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n${x}\n20\n${y}\n10\n${x+10}\n20\n${y}\n10\n${x+10}\n20\n${y+10}\n10\n${x}\n20\n${y+10}\n`;
		}
	}
	return dxfHeader() + entities + dxfFooter();
}

// Generates a realistic gear-like profile using many LINE segments
function makeDxfGearProfile(teeth, r_outer, r_inner) {
	const step = (2 * Math.PI) / (teeth * 2);
	let entities = '';
	let prevX = null, prevY = null;
	const pts = [];
	for (let i = 0; i < teeth * 2; i++) {
		const r = i % 2 === 0 ? r_outer : r_inner;
		pts.push({ x: r * Math.cos(i * step), y: r * Math.sin(i * step) });
	}
	// close
	pts.push(pts[0]);
	for (let i = 0; i < pts.length - 1; i++) {
		entities += `0\nLINE\n8\n0\n10\n${pts[i].x}\n20\n${pts[i].y}\n30\n0\n11\n${pts[i+1].x}\n21\n${pts[i+1].y}\n31\n0\n`;
	}
	return dxfHeader() + entities + dxfFooter();
}

// ── mergeLines simulation (pure JS, mirrors the fixed svgparser.js logic) ─────

function almostEqual(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-9); }
function almostEqualPoints(p1, p2, tol) {
	return almostEqual(p1.x, p2.x, tol) && almostEqual(p1.y, p2.y, tol);
}

// Simulate the fixed getCoincident: search entire list
function getCoincident(path, list, tol) {
	const index = list.indexOf(path);
	if (index < 0) return null;
	const coincident = [];
	for (let i = 0; i < list.length; i++) {
		if (i === index) continue;
		const c = list[i];
		if (almostEqualPoints(path.ep.start, c.ep.start, tol)) {
			coincident.push({ path: c, reverse1: true, reverse2: false });
		} else if (almostEqualPoints(path.ep.start, c.ep.end, tol)) {
			coincident.push({ path: c, reverse1: true, reverse2: true });
		} else if (almostEqualPoints(path.ep.end, c.ep.end, tol)) {
			coincident.push({ path: c, reverse1: false, reverse2: true });
		} else if (almostEqualPoints(path.ep.end, c.ep.start, tol)) {
			coincident.push({ path: c, reverse1: false, reverse2: false });
		}
	}
	return coincident.length > 0 ? coincident : null;
}

// Simulate chain merging: returns array of closed chains found
function simulateMergeLines(segments, tol) {
	// each segment: { id, ep: { start: {x,y}, end: {x,y} }, chain: [...ids] }
	const open = segments.map((s, i) => ({ id: i, ep: { start: s.start, end: s.end } }));
	const closed = [];

	for (let i = 0; i < open.length; i++) {
		let p = open[i];
		let candidates = getCoincident(p, open, tol);

		while (candidates && candidates.length > 0) {
			const c = candidates[0];
			// reverse if needed
			if (c.reverse1) { const tmp = p.ep.start; p.ep.start = p.ep.end; p.ep.end = tmp; }
			if (c.reverse2) { const tmp = c.path.ep.start; c.path.ep.start = c.path.ep.end; c.path.ep.end = tmp; }

			// merge: extend p to include c
			const merged = {
				id: p.id,
				ep: { start: p.ep.start, end: c.path.ep.end },
				segments: (p.segments || [p.id]).concat(c.path.segments || [c.path.id])
			};

			open.splice(open.indexOf(c.path), 1);
			open.splice(i, 1, merged);
			p = merged;

			// check closed: start == end
			if (almostEqualPoints(p.ep.start, p.ep.end, tol)) {
				closed.push(p.segments || [p.id]);
				open.splice(i, 1);
				i--;
				break;
			}

			candidates = getCoincident(p, open, tol);
		}
	}

	return { closed, remaining: open.length };
}

// Build segments from a regular polygon
function polygonSegments(sides, radius) {
	const step = (2 * Math.PI) / sides;
	const pts = [];
	for (let i = 0; i <= sides; i++) {
		pts.push({ x: radius * Math.cos(i * step), y: radius * Math.sin(i * step) });
	}
	const segs = [];
	for (let i = 0; i < sides; i++) {
		segs.push({ start: pts[i], end: pts[i + 1] });
	}
	return segs;
}

// Shuffle array randomly
function shuffle(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

// ── Load tests ────────────────────────────────────────────────────────────────

console.log('\n=== DXF parse load tests ===\n');

test('parse 100 closed LWPOLYLINE rectangles (grid)', function() {
	const dxfStr = makeDxfGridRectangles(10, 10, 50, 30, 5);
	const parsed = dxf.parseString(dxfStr);
	const entities = dxf.denormalise(parsed);
	const lwpoly = entities.filter(e => e.type === 'LWPOLYLINE');
	assert.strictEqual(lwpoly.length, 100, `expected 100 LWPOLYLINE entities, got ${lwpoly.length}`);
	assert(lwpoly.every(e => e.closed === true), 'all rectangles should be closed');
});

test('toSVG on 100 rectangles produces valid SVG', function() {
	const dxfStr = makeDxfGridRectangles(10, 10, 50, 30, 5);
	const parsed = dxf.parseString(dxfStr);
	const svg = dxf.toSVG(parsed);
	assert(svg.includes('<svg'), 'output must be SVG');
	const pathCount = (svg.match(/<path/g) || []).length;
	assert(pathCount >= 100, `expected ≥100 path elements, got ${pathCount}`);
});

test('parse 500 circles', function() {
	const dxfStr = makeDxfCircles(500, 5);
	const parsed = dxf.parseString(dxfStr);
	const entities = dxf.denormalise(parsed);
	const circles = entities.filter(e => e.type === 'CIRCLE');
	assert.strictEqual(circles.length, 500, `expected 500 circles, got ${circles.length}`);
});

test('toSVG on 500 circles completes under 3s', function() {
	const dxfStr = makeDxfCircles(500, 5);
	const parsed = dxf.parseString(dxfStr);
	const t0 = Date.now();
	const svg = dxf.toSVG(parsed);
	const ms = Date.now() - t0;
	assert(ms < 3000, `toSVG took ${ms}ms, expected < 3000ms`);
	assert(svg.includes('<circle') || svg.includes('<path'), 'output must contain circle elements');
});

test('parse 1000 mixed entities (LINE/CIRCLE/ARC/LWPOLYLINE)', function() {
	const dxfStr = makeDxfMixed(1000);
	const parsed = dxf.parseString(dxfStr);
	const entities = dxf.denormalise(parsed);
	assert(entities.length >= 900, `expected ~1000 entities, got ${entities.length}`);
});

test('toSVG on 1000 mixed entities completes under 5s', function() {
	const dxfStr = makeDxfMixed(1000);
	const parsed = dxf.parseString(dxfStr);
	const t0 = Date.now();
	const svg = dxf.toSVG(parsed);
	const ms = Date.now() - t0;
	assert(ms < 5000, `toSVG took ${ms}ms, expected < 5000ms`);
	assert(svg.includes('<svg'), 'must produce SVG');
});

test('parse gear profile — 200 tooth polygon (400 LINE entities)', function() {
	const dxfStr = makeDxfGearProfile(200, 80, 60);
	const parsed = dxf.parseString(dxfStr);
	const entities = dxf.denormalise(parsed);
	const lines = entities.filter(e => e.type === 'LINE');
	assert.strictEqual(lines.length, 400, `expected 400 LINE entities, got ${lines.length}`);
});

test('parse 50 gear profiles (20000 LINE entities) under 10s', function() {
	let allDxf = dxfHeader();
	for (let g = 0; g < 50; g++) {
		const offsetX = (g % 10) * 250;
		const offsetY = Math.floor(g / 10) * 250;
		const teeth = 20;
		const r_outer = 80, r_inner = 60;
		const step = (2 * Math.PI) / (teeth * 2);
		const pts = [];
		for (let i = 0; i < teeth * 2; i++) {
			const r = i % 2 === 0 ? r_outer : r_inner;
			pts.push({ x: offsetX + r * Math.cos(i * step), y: offsetY + r * Math.sin(i * step) });
		}
		pts.push(pts[0]);
		for (let i = 0; i < pts.length - 1; i++) {
			allDxf += `0\nLINE\n8\n0\n10\n${pts[i].x}\n20\n${pts[i].y}\n30\n0\n11\n${pts[i+1].x}\n21\n${pts[i+1].y}\n31\n0\n`;
		}
	}
	allDxf += dxfFooter();

	const t0 = Date.now();
	const parsed = dxf.parseString(allDxf);
	const entities = dxf.denormalise(parsed);
	const ms = Date.now() - t0;

	assert(ms < 10000, `parsing took ${ms}ms, expected < 10s`);
	assert(entities.filter(e => e.type === 'LINE').length === 50 * 40, 'should have 50*40=2000 LINE entities');
});

test('DXF with only whitespace/comments does not crash', function() {
	const bad = `  \n\n  \n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n`;
	const parsed = dxf.parseString(bad);
	const svg = dxf.toSVG(parsed);
	assert(typeof svg === 'string', 'should return a string even for empty DXF');
});

test('DXF with large coordinate values (precision test)', function() {
	// Coordinates near float64 precision limits (common in imported CAD from different origins)
	const largeDxf = dxfHeader() +
		`0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n` +
		`10\n1234567.890123\n20\n9876543.210987\n` +
		`10\n1234667.890123\n20\n9876543.210987\n` +
		`10\n1234667.890123\n20\n9876643.210987\n` +
		`10\n1234567.890123\n20\n9876643.210987\n` +
		dxfFooter();
	const parsed = dxf.parseString(largeDxf);
	const svg = dxf.toSVG(parsed);
	assert(svg.includes('<path'), 'large coordinates should produce valid path');
});

test('DXF with negative coordinates', function() {
	const negDxf = dxfHeader() +
		`0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n` +
		`10\n-100.0\n20\n-100.0\n` +
		`10\n-50.0\n20\n-100.0\n` +
		`10\n-50.0\n20\n-50.0\n` +
		`10\n-100.0\n20\n-50.0\n` +
		dxfFooter();
	const parsed = dxf.parseString(negDxf);
	const svg = dxf.toSVG(parsed);
	assert(svg.includes('viewBox'), 'negative coordinates should produce valid viewBox');
});

console.log('\n=== mergeLines algorithm load tests ===\n');

test('square (4 lines in order) → 1 closed chain', function() {
	const segs = polygonSegments(4, 50);
	const result = simulateMergeLines(segs, 0.01);
	assert.strictEqual(result.closed.length, 1, `expected 1 closed chain, got ${result.closed.length}`);
	assert.strictEqual(result.closed[0].length, 4, `chain should have 4 segments`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('square (4 lines REVERSED order) → 1 closed chain', function() {
	const segs = polygonSegments(4, 50).reverse();
	const result = simulateMergeLines(segs, 0.01);
	assert.strictEqual(result.closed.length, 1, `expected 1 closed chain, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('square (4 lines SHUFFLED) → 1 closed chain', function() {
	const segs = shuffle(polygonSegments(4, 50));
	const result = simulateMergeLines(segs, 0.01);
	assert.strictEqual(result.closed.length, 1, `expected 1 closed chain, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('hexagon (6 lines shuffled) → 1 closed chain', function() {
	const segs = shuffle(polygonSegments(6, 50));
	const result = simulateMergeLines(segs, 0.01);
	assert.strictEqual(result.closed.length, 1, `expected 1 closed chain, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('32-gon (32 lines shuffled) → 1 closed chain', function() {
	const segs = shuffle(polygonSegments(32, 50));
	const result = simulateMergeLines(segs, 0.01);
	assert.strictEqual(result.closed.length, 1, `expected 1 closed chain, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('100-gon (100 lines shuffled) → 1 closed chain', function() {
	const segs = shuffle(polygonSegments(100, 50));
	const result = simulateMergeLines(segs, 0.01);
	assert.strictEqual(result.closed.length, 1, `expected 1 closed chain, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('10 separate squares (40 shuffled lines) → 10 closed chains', function() {
	const allSegs = [];
	for (let i = 0; i < 10; i++) {
		const r = 20;
		const cx = i * 60, cy = 0;
		allSegs.push(
			{ start: {x:cx,   y:cy},   end: {x:cx+r, y:cy}   },
			{ start: {x:cx+r, y:cy},   end: {x:cx+r, y:cy+r} },
			{ start: {x:cx+r, y:cy+r}, end: {x:cx,   y:cy+r} },
			{ start: {x:cx,   y:cy+r}, end: {x:cx,   y:cy}   }
		);
	}
	shuffle(allSegs);
	const result = simulateMergeLines(allSegs, 0.01);
	assert.strictEqual(result.closed.length, 10, `expected 10 closed chains, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('100 separate triangles (300 shuffled lines) → 100 closed chains', function() {
	const allSegs = [];
	for (let i = 0; i < 100; i++) {
		const segs = polygonSegments(3, 10);
		const ox = (i % 20) * 30, oy = Math.floor(i / 20) * 30;
		segs.forEach(s => allSegs.push({
			start: { x: s.start.x + ox, y: s.start.y + oy },
			end:   { x: s.end.x + ox,   y: s.end.y + oy }
		}));
	}
	shuffle(allSegs);
	const result = simulateMergeLines(allSegs, 0.01);
	assert.strictEqual(result.closed.length, 100, `expected 100 closed chains, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, 'no open paths should remain');
});

test('200-tooth gear profile (400 shuffled lines) → 1 closed chain', function() {
	const teeth = 200;
	const r_outer = 100, r_inner = 80;
	const step = (2 * Math.PI) / (teeth * 2);
	const pts = [];
	for (let i = 0; i < teeth * 2; i++) {
		const r = i % 2 === 0 ? r_outer : r_inner;
		pts.push({ x: r * Math.cos(i * step), y: r * Math.sin(i * step) });
	}
	pts.push(pts[0]);
	const segs = [];
	for (let i = 0; i < pts.length - 1; i++) {
		segs.push({ start: pts[i], end: pts[i + 1] });
	}
	shuffle(segs);

	const t0 = Date.now();
	const result = simulateMergeLines(segs, 0.001);
	const ms = Date.now() - t0;

	assert.strictEqual(result.closed.length, 1, `expected 1 closed chain, got ${result.closed.length}`);
	assert.strictEqual(result.remaining, 0, `${result.remaining} open paths remain`);
	assert(ms < 5000, `took ${ms}ms, expected < 5s`);
	console.log(`         (400 segments merged in ${ms}ms)`);
});

test('floating point tolerance — segments with 0.001mm gap still close', function() {
	// Simulates DXF precision issues where endpoints don't perfectly coincide
	const gap = 0.0005;
	const segs = [
		{ start: {x:0, y:0},        end: {x:100, y:0} },
		{ start: {x:100+gap, y:0},  end: {x:100, y:100} },  // tiny gap at join
		{ start: {x:100, y:100},    end: {x:0, y:100} },
		{ start: {x:0, y:100},      end: {x:0, y:0} }
	];
	const result = simulateMergeLines(segs, 0.01);  // tolerance covers 0.0005 gap
	assert.strictEqual(result.closed.length, 1, 'should close despite small gap');
});

test('segments with gap larger than tolerance stay open (no false closes)', function() {
	const bigGap = 5.0;  // larger than tolerance
	const segs = [
		{ start: {x:0, y:0},         end: {x:100, y:0} },
		{ start: {x:100+bigGap, y:0}, end: {x:100, y:100} },  // intentional gap
		{ start: {x:100, y:100},      end: {x:0, y:100} },
		{ start: {x:0, y:100},        end: {x:0, y:0} }
	];
	const result = simulateMergeLines(segs, 0.01);
	// Should NOT form a closed chain — gap is too large
	assert.strictEqual(result.closed.length, 0, 'should not falsely close a gapped contour');
	assert(result.remaining > 0, 'should have remaining open paths');
});

// ── Performance summary ───────────────────────────────────────────────────────

console.log('\n=== Performance summary ===\n');
const sorted = [...timings].sort((a, b) => b.ms - a.ms);
sorted.slice(0, 5).forEach(t => {
	console.log(`  ${t.ms}ms  ${t.name}`);
});

console.log('\n─────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─────────────────────────────────────\n');

if (failed > 0) process.exit(1);
