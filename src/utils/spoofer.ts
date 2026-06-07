/**
 * Header spoofer helpers.
 *
 * When a provider has `spoofer: true`, the proxy injects a randomized set
 * of IP-spoofing headers into each upstream request:
 *
 *   X-Forwarded-For:    <random ipv4>
 *   X-Real-IP:          <random ipv4>
 *   Forwarded:          for=<random ipv4>
 *   True-Client-IP:     <random ipv4>
 *   CF-Connecting-IP:   <random ipv4>
 *   CF-Connecting-IPv6: <random ipv6>
 *   CF-Pseudo-IPv4:     <random ipv4>
 *
 * All values are regenerated on every call so each upstream request looks
 * like it is coming from a different client.
 */

/**
 * Generate a random integer in the inclusive range [min, max].
 */
function randomInt( min: number, max: number ): number {
    return Math.floor( Math.random() * ( max - min + 1 ) ) + min;
}

/**
 * Generate a random public-looking IPv4 address.
 *
 * The result avoids reserved/private ranges (0.0.0.0/8, 10.0.0.0/8,
 * 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16,
 * 224.0.0.0/4, 240.0.0.0/4) so that the value looks like a normal
 * residential / ISP-assigned address.
 */
export function randomIPv4(): string {
    // First octet: avoid 0, 10, 127, 169, 172 (16-31), 192, 224+, 240+
    const firstOctets = [
        1, 2, 3, 4, 5, 6, 7, 8, 9,
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
        33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
        48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
        64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,
        96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123,
        124, 125, 126,
        128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171,
        173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191,
        193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223,
    ];
    const first = firstOctets[randomInt( 0, firstOctets.length - 1 )]!;

    // Second octet: avoid 0 if first is 100-127 (CPNI), avoid 16 if first is 172
    let second = randomInt( 0, 255 );
    if ( first === 100 && second >= 64 && second <= 127 ) {
        second = randomInt( 0, 63 );
    }
    if ( first === 172 && second === 16 ) {
        second = randomInt( 17, 31 );
    }
    if ( first === 192 && second === 168 ) {
        second = randomInt( 0, 167 );
    }

    // Third / fourth octets can be anything (0-255) — the value just needs
    // to be non-trivial so it doesn't look obviously fake.
    const third = randomInt( 0, 255 );
    const fourth = randomInt( 1, 254 );

    return `${first}.${second}.${third}.${fourth}`;
}

/**
 * Generate a random IPv6 address using a documented documentation prefix
 * (2001:db8::/32) or a globally-unicast prefix (2000::/3).
 */
export function randomIPv6(): string {
    const groups: number[] = [];
    for ( let i = 0; i < 8; i++ ) {
        groups.push( randomInt( 0, 0xFFFF ) );
    }

    // First group: prefer 2000-3fff (global unicast) or 2001:db8:: (documentation)
    const useDoc = Math.random() < 0.5;
    if ( useDoc ) {
        groups[0] = 0x2001;
        groups[1] = 0x0db8;
        // remaining groups are random
    } else {
        groups[0] = randomInt( 0x2000, 0x3fff );
    }

    return groups.map( ( g ) => g.toString( 16 ) ).join( ':' );
}

/**
 * Build the full set of spoofing headers for a single upstream request.
 * Each call returns fresh random values.
 */
export function buildSpoofHeaders(): Record<string, string> {
    const ipv4 = randomIPv4();
    const pseudo = randomIPv4();
    const ipv6 = randomIPv6();

    return {
        'X-Forwarded-For': ipv4,
        'X-Real-IP': ipv4,
        'Forwarded': `for=${ipv4}`,
        'True-Client-IP': ipv4,
        'CF-Connecting-IP': ipv4,
        'CF-Connecting-IPv6': ipv6,
        'CF-Pseudo-IPv4': pseudo,
    };
}

/**
 * Merge spoofer headers into an existing header object. Returns a new
 * object — the input is not mutated.
 */
export function applySpoofHeaders<T extends Record<string, string>>( headers: T ): Record<string, string> {
    return {
        ...headers,
        ...buildSpoofHeaders(),
    };
}
