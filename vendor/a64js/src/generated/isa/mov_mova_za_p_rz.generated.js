export const ENCODINGS = [
    {
        "instructionId": "mov_mova_za_p_rz",
        "encodingId": "mov_za_p_rz_b_mova_za_p_rz_b",
        "mnemonic": "MOVA",
        "className": "8-bit",
        "fileName": "mov_mova_za_p_rz.xml",
        "mask": 4294901776,
        "value": 3221225472,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 16,
                "width": 1
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
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "off4",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za_p_rz_b",
        "canonicalFileName": "mova_za_p_rz.xml",
        "operandFamilyId": "mova-vector-to-single"
    },
    {
        "instructionId": "mov_mova_za_p_rz",
        "encodingId": "mov_za_p_rz_d_mova_za_p_rz_d",
        "mnemonic": "MOVA",
        "className": "64-bit",
        "fileName": "mov_mova_za_p_rz.xml",
        "mask": 4294901776,
        "value": 3233808384,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 16,
                "width": 1
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
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ZAd",
                "lsb": 1,
                "width": 3
            },
            {
                "name": "o1",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za_p_rz_d",
        "canonicalFileName": "mova_za_p_rz.xml",
        "operandFamilyId": "mova-vector-to-single"
    },
    {
        "instructionId": "mov_mova_za_p_rz",
        "encodingId": "mov_za_p_rz_h_mova_za_p_rz_h",
        "mnemonic": "MOVA",
        "className": "16-bit",
        "fileName": "mov_mova_za_p_rz.xml",
        "mask": 4294901776,
        "value": 3225419776,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 16,
                "width": 1
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
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ZAd",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za_p_rz_h",
        "canonicalFileName": "mova_za_p_rz.xml",
        "operandFamilyId": "mova-vector-to-single"
    },
    {
        "instructionId": "mov_mova_za_p_rz",
        "encodingId": "mov_za_p_rz_q_mova_za_p_rz_q",
        "mnemonic": "MOVA",
        "className": "128-bit",
        "fileName": "mov_mova_za_p_rz.xml",
        "mask": 4294901776,
        "value": 3233873920,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 16,
                "width": 1
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
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ZAd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za_p_rz_q",
        "canonicalFileName": "mova_za_p_rz.xml",
        "operandFamilyId": "mova-vector-to-single"
    },
    {
        "instructionId": "mov_mova_za_p_rz",
        "encodingId": "mov_za_p_rz_w_mova_za_p_rz_w",
        "mnemonic": "MOVA",
        "className": "32-bit",
        "fileName": "mov_mova_za_p_rz.xml",
        "mask": 4294901776,
        "value": 3229614080,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 16,
                "width": 1
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
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ZAd",
                "lsb": 2,
                "width": 2
            },
            {
                "name": "off2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_za_p_rz_w",
        "canonicalFileName": "mova_za_p_rz.xml",
        "operandFamilyId": "mova-vector-to-single"
    }
];
