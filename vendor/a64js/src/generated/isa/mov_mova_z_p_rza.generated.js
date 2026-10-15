export const ENCODINGS = [
    {
        "instructionId": "mov_mova_z_p_rza",
        "encodingId": "mov_z_p_rza_b_mova_z_p_rza_b",
        "mnemonic": "MOVA",
        "className": "8-bit",
        "fileName": "mov_mova_z_p_rza.xml",
        "mask": 4294902272,
        "value": 3221356544,
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
                "name": "off4",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "canonicalEncodingId": "mova_z_p_rza_b",
        "canonicalFileName": "mova_z_p_rza.xml",
        "operandFamilyId": "mova-single-to-vector"
    },
    {
        "instructionId": "mov_mova_z_p_rza",
        "encodingId": "mov_z_p_rza_d_mova_z_p_rza_d",
        "mnemonic": "MOVA",
        "className": "64-bit",
        "fileName": "mov_mova_z_p_rza.xml",
        "mask": 4294902272,
        "value": 3233939456,
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
                "name": "ZAn",
                "lsb": 6,
                "width": 3
            },
            {
                "name": "o1",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "canonicalEncodingId": "mova_z_p_rza_d",
        "canonicalFileName": "mova_z_p_rza.xml",
        "operandFamilyId": "mova-single-to-vector"
    },
    {
        "instructionId": "mov_mova_z_p_rza",
        "encodingId": "mov_z_p_rza_h_mova_z_p_rza_h",
        "mnemonic": "MOVA",
        "className": "16-bit",
        "fileName": "mov_mova_z_p_rza.xml",
        "mask": 4294902272,
        "value": 3225550848,
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
                "name": "ZAn",
                "lsb": 8,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "canonicalEncodingId": "mova_z_p_rza_h",
        "canonicalFileName": "mova_z_p_rza.xml",
        "operandFamilyId": "mova-single-to-vector"
    },
    {
        "instructionId": "mov_mova_z_p_rza",
        "encodingId": "mov_z_p_rza_q_mova_z_p_rza_q",
        "mnemonic": "MOVA",
        "className": "128-bit",
        "fileName": "mov_mova_z_p_rza.xml",
        "mask": 4294902272,
        "value": 3234004992,
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
                "name": "ZAn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "canonicalEncodingId": "mova_z_p_rza_q",
        "canonicalFileName": "mova_z_p_rza.xml",
        "operandFamilyId": "mova-single-to-vector"
    },
    {
        "instructionId": "mov_mova_z_p_rza",
        "encodingId": "mov_z_p_rza_w_mova_z_p_rza_w",
        "mnemonic": "MOVA",
        "className": "32-bit",
        "fileName": "mov_mova_z_p_rza.xml",
        "mask": 4294902272,
        "value": 3229745152,
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
                "name": "ZAn",
                "lsb": 7,
                "width": 2
            },
            {
                "name": "off2",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "canonicalEncodingId": "mova_z_p_rza_w",
        "canonicalFileName": "mova_z_p_rza.xml",
        "operandFamilyId": "mova-single-to-vector"
    }
];
