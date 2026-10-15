export const ENCODINGS = [
    {
        "instructionId": "mov_mova_za4_z",
        "encodingId": "mov_za4_z_b1_mova_za4_z_b1",
        "mnemonic": "MOVA",
        "className": "8-bit",
        "fileName": "mov_mova_za4_z.xml",
        "mask": 4294909052,
        "value": 3221488640,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "off2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za4_z_b1",
        "canonicalFileName": "mova_za4_z.xml",
        "operandFamilyId": "mova-vectors-to-slice-mov-mova-za4-z"
    },
    {
        "instructionId": "mov_mova_za4_z",
        "encodingId": "mov_za4_z_h1_mova_za4_z_h1",
        "mnemonic": "MOVA",
        "className": "16-bit",
        "fileName": "mov_mova_za4_z.xml",
        "mask": 4294909052,
        "value": 3225682944,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "ZAd",
                "lsb": 1,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za4_z_h1",
        "canonicalFileName": "mova_za4_z.xml",
        "operandFamilyId": "mova-vectors-to-slice-mov-mova-za4-z"
    },
    {
        "instructionId": "mov_mova_za4_z",
        "encodingId": "mov_za4_z_w1_mova_za4_z_w1",
        "mnemonic": "MOVA",
        "className": "32-bit",
        "fileName": "mov_mova_za4_z.xml",
        "mask": 4294909052,
        "value": 3229877248,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "ZAd",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za4_z_w1",
        "canonicalFileName": "mova_za4_z.xml",
        "operandFamilyId": "mova-vectors-to-slice-mov-mova-za4-z"
    },
    {
        "instructionId": "mov_mova_za4_z",
        "encodingId": "mov_za4_z_d1_mova_za4_z_d1",
        "mnemonic": "MOVA",
        "className": "64-bit",
        "fileName": "mov_mova_za4_z.xml",
        "mask": 4294909048,
        "value": 3234071552,
        "bitCount": 23,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "ZAd",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za4_z_d1",
        "canonicalFileName": "mova_za4_z.xml",
        "guardDiagnostics": [
            "MaxImplementedSVL() < 256: maximum streaming vector length is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "mova-vectors-to-slice-mov-mova-za4-z"
    }
];
