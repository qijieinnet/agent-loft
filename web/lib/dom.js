// ---------- 小工具 ----------

export const $app = document.getElementById("app");
export const isTouch = matchMedia("(pointer: coarse)").matches;

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** replaceChildren 会把 null 变成字面量 "null"，统一过滤掉 */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

export const ICON = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  compose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12.5 14.3 9 15l.7-3.5Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  caret:'<svg viewBox="0 0 10 10" fill="currentColor"><path d="M1.6 3.2h6.8L5 7.4Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  fork: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-6 4-11.2 8.6"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 20.5l1.6-5A8.4 8.4 0 1 1 21 11.5Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/><path d="M3 10h18"/></svg>',
  folderOpen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17.5V7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h6.4A2.5 2.5 0 0 1 20 9.7V11"/><path d="M3 17.5 5.6 12a2 2 0 0 1 1.8-1.1h13a1 1 0 0 1 .9 1.4l-2.4 6.2a2.2 2.2 0 0 1-2 1.5H5.5A2.5 2.5 0 0 1 3 17.5Z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>',
  unplug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/></svg>',
  shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
  pointer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 7-6 2-2 6Z"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V5a1.5 1.5 0 0 1 3 0v5"/><path d="M12 10V4a1.5 1.5 0 0 1 3 0v6"/><path d="M15 10V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3.4 15a1.6 1.6 0 0 1 2.4-2.1L9 15.5V11"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9M12 17h.01"/></svg>',
  gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
  maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  logo: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 8.5a8 8 0 0 1 13.2 0 8 8 0 0 1 9 9.4 8 8 0 0 1 0 12.2 8 8 0 0 1-9 9.4 8 8 0 0 1-13.2 0 8 8 0 0 1-9-9.4 8 8 0 0 1 0-12.2 8 8 0 0 1 9-9.4Z"/><path d="m17 18 5 5-5 5M25 30h7"/></svg>',
  feishu:
    '<svg viewBox="2 4 44 40"><path fill="#00D6B9" d="M11.6 7H27.6C30.9 9.9 32.8 14.7 33.6 17C30.9 18.3 29 20.6 27 24C22.6 16.4 15.6 11 11.6 7Z"/><path fill="#133C9A" d="M17 29C21 29 25 26.9 28 23.4C36 14 41.4 16.8 44 18C38.5 21 40.5 29.6 33 36C27.5 34.8 21.8 32.2 17 29Z"/><path fill="#3370FF" d="M4 16.2C7.2 20.8 12.4 26 17.4 29.4C23 33.2 28.6 35.7 34 35.2C28.9 39.8 23.8 41 19 41C12.5 41 6.9 37.8 4 35.4Z"/></svg>',
};

/** Claude 的标志（橙色放射状），也是内置专家 Claude Code 的头像 */
ICON.claude = '<svg viewBox="0 0 640 640"><path fill="#D97757" fill-rule="evenodd" d="M173 2C168 3 167 4 158 17C146 32 146 32 151 52C155 66 155 66 164 81C188 118 252 233 250 235C248 238 246 237 241 233C238 230 221 218 203 204C185 191 156 169 138 156C94 122 96 123 92 122C90 122 84 121 77 120L66 120 58 129L49 139 51 152C52 159 53 165 53 165C53 168 65 179 74 186C80 190 92 199 101 205C110 211 129 225 144 235C185 262 247 304 252 307C254 310 255 311 254 312C253 315 246 315 212 311C196 309 170 307 153 306C114 304 35 298 24 297L14 296 8 301C2 305 1 305 1 310C0 314 0 314 7 323L14 333 21 334C31 337 103 341 170 342C230 344 251 345 252 347C253 347 253 349 253 351C252 355 251 355 190 390C136 420 124 427 102 442C68 465 69 464 68 477L67 486 74 493C79 498 81 499 83 498C84 498 91 497 98 496L110 495 194 440C240 410 279 386 280 385C281 385 281 386 281 387C281 389 277 394 269 404C262 411 248 429 238 442C227 456 204 486 186 509C143 564 143 563 143 574L142 583 152 588L161 593 167 590C172 588 174 586 196 563C220 536 230 524 295 435C308 416 315 408 316 408C318 408 318 408 316 417C315 421 312 436 310 450C306 475 295 533 284 584L279 608 283 618C287 628 287 628 296 634L304 640 313 636C321 633 323 632 327 628L331 623 340 526C348 445 349 429 351 428C353 427 353 426 369 454C395 498 454 586 459 588C461 588 465 589 469 590C476 591 476 591 484 588C492 586 492 585 494 581L496 576 495 562L493 547 456 492C436 461 419 435 419 434C419 433 420 432 421 432C423 432 460 463 486 486C501 499 553 538 557 539C563 541 564 540 569 534L573 528 571 520C570 514 569 512 566 509C556 500 502 450 478 429C447 401 420 374 420 372C420 370 424 371 443 375C453 378 493 388 533 397L606 414 622 406L638 398 639 392L640 385 634 377C628 369 626 367 617 361L606 354 574 351C553 350 528 349 502 348C464 347 425 344 423 342C422 341 419 342 472 329C496 323 531 316 549 312C568 308 594 302 606 299L629 294 633 283C638 273 638 272 637 267L636 262 625 257L613 251 591 255C548 262 523 267 486 275C439 285 443 284 441 283C440 281 441 278 450 263C463 241 486 209 540 142C547 133 547 132 551 118C553 110 555 103 555 102C555 101 551 94 545 86L536 72 521 72L507 72 499 79C480 94 436 145 396 199C381 219 375 226 371 226C370 226 369 225 369 225C369 223 376 184 386 133C390 114 395 83 398 66L403 35 396 26C390 18 389 17 383 13C379 12 375 10 375 10C374 10 369 13 364 16L354 23 349 35C343 49 344 45 339 105C337 125 335 152 333 167C331 181 329 202 329 212C326 245 326 244 324 244C322 244 321 241 317 229C313 216 311 211 286 162C261 113 248 87 226 35C212 4 212 4 181 1C179 0 175 1 173 2"/></svg>';
/** OpenAI 的标志，也是内置专家 Codex 的头像。跟着文字颜色（深色模式下是白的） */
ICON.codex = '<svg viewBox="0 0 640 640"><path fill="currentColor" fill-rule="evenodd" d="M253 1C193 8 141 51 122 109C120 115 118 121 117 123C117 127 117 127 108 130C31 154 -16 240 6 321C12 346 26 370 45 391L53 399 52 407C43 448 51 491 75 527C83 539 104 560 116 569C156 596 205 604 250 591L257 589 264 595C284 613 307 624 335 631C351 635 382 635 399 631C461 618 506 575 523 511C523 508 524 508 534 504C587 485 625 442 637 384C640 369 640 341 637 325C631 293 616 266 594 244L587 236 588 228C606 142 552 60 466 41C442 36 412 37 390 44L384 46 375 38C340 9 297 -4 253 1M259 39C258 39 253 39 249 40C206 46 169 78 156 119C150 137 150 139 150 224L150 302 153 305C156 308 206 338 207 338C208 338 208 296 208 245C208 181 208 150 209 148C211 140 215 138 280 100C314 80 343 64 343 63C345 61 322 48 308 44C293 39 272 37 259 39M405 78C385 82 385 82 309 126C271 148 249 161 248 163C246 166 245 168 245 198C245 220 245 230 246 230C247 230 283 209 326 184C412 134 410 135 416 135C422 135 421 135 489 174C524 195 552 211 553 211C554 209 554 196 553 186C547 133 512 92 462 79C448 76 418 75 405 78M103 173C62 194 36 238 38 284C40 316 53 346 75 368C86 379 88 380 145 413C171 428 199 444 206 448C217 454 221 456 224 456C227 456 281 427 281 425C281 425 245 403 201 378C157 353 120 331 119 329C112 323 113 327 112 244L112 169 103 173M385 194C370 202 358 209 358 209C358 210 394 231 438 256C482 281 519 303 521 305C522 306 525 309 526 311C528 316 528 316 528 390C528 444 528 465 529 465C531 465 547 456 554 451C612 407 618 321 566 267C554 256 553 255 497 222C416 176 420 178 416 178C413 178 406 181 385 194M282 252L246 273 246 317L246 362 282 382C303 394 320 403 320 403C321 403 388 365 393 362L395 361 395 317L394 273 358 252C337 240 320 231 320 231C320 231 303 240 282 252M432 389C432 453 432 484 431 486C429 494 425 497 360 535C325 554 297 571 297 571C295 572 307 580 317 585C336 593 353 597 374 596C432 593 475 558 489 502C491 490 492 336 489 331C488 328 483 325 460 312C445 303 433 296 432 296C432 296 432 338 432 389M376 414C367 419 331 440 297 460C230 498 228 500 222 499C217 498 220 500 150 459C117 440 89 424 88 424C87 424 86 440 87 450C91 492 115 527 153 545C183 561 223 563 254 551C264 547 388 476 391 472L394 469 394 436C394 419 394 404 394 404C394 404 386 408 376 414"/></svg>';

/**
 * 星星加载动画（回复末尾、打开会话时用）。开屏那个带台面的完整 logo 动画直接写在 index.html 里。
 * 每个实例的渐变 id 唯一，避免页面里有隐藏的同 id 渐变时画不出来。
 * 动画按全局时钟设负的起始延迟：回复被授权卡片分成几段时，新一段的动画接着播、不会一抖一抖地重来。
 */
let loaderSeq = 0;

/** 只有 logo 中间那颗大星，一边旋转一边放大缩小 */
const STARS_MS = 1800;
export function starsLoader(cls = "") {
  const id = `loft-g${++loaderSeq}`;
  const el = h("span", {
    class: `loft-stars${cls ? ` ${cls}` : ""}`,
    role: "img",
    "aria-label": "回复中",
    html: `<svg viewBox="180 82 152 152" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="180" y1="82" x2="332" y2="234"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><path d="M256 82C268.92 145.08 268.92 145.08 332 158C268.92 170.92 268.92 170.92 256 234C243.08 170.92 243.08 170.92 180 158C243.08 145.08 243.08 145.08 256 82Z" fill="url(#${id})"/></svg>`,
  });
  el.style.setProperty("--t", `${-(performance.now() % STARS_MS).toFixed(0)}ms`);
  return el;
}

export function agentIcon(id, cls = "agent-icon") {
  return h("span", { class: cls, html: ICON[id] ?? ICON.laptop });
}

export function icon(name) {
  return h("span", { html: ICON[name], style: { display: "inline-grid" } });
}

export function toast(text, ms = 2600) {
  const el = h("div", { class: "toast" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}
