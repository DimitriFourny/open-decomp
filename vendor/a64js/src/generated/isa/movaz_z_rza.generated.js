export const ENCODINGS = [
    {
        "instructionId": "movaz_z_rza",
        "encodingId": "movaz_z_rza_b",
        "mnemonic": "MOVAZ",
        "className": "8-bit",
        "fileName": "movaz_z_rza.xml",
        "mask": 4294909440,
        "value": 3221357056,
        "bitCount": 20,
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
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "movaz-single-to-vector"
    },
    {
        "instructionId": "movaz_z_rza",
        "encodingId": "movaz_z_rza_d",
        "mnemonic": "MOVAZ",
        "className": "64-bit",
        "fileName": "movaz_z_rza.xml",
        "mask": 4294909440,
        "value": 3233939968,
        "bitCount": 20,
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
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "movaz-single-to-vector"
    },
    {
        "instructionId": "movaz_z_rza",
        "encodingId": "movaz_z_rza_h",
        "mnemonic": "MOVAZ",
        "className": "16-bit",
        "fileName": "movaz_z_rza.xml",
        "mask": 4294909440,
        "value": 3225551360,
        "bitCount": 20,
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
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "movaz-single-to-vector"
    },
    {
        "instructionId": "movaz_z_rza",
        "encodingId": "movaz_z_rza_q",
        "mnemonic": "MOVAZ",
        "className": "128-bit",
        "fileName": "movaz_z_rza.xml",
        "mask": 4294909440,
        "value": 3234005504,
        "bitCount": 20,
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
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "movaz-single-to-vector"
    },
    {
        "instructionId": "movaz_z_rza",
        "encodingId": "movaz_z_rza_w",
        "mnemonic": "MOVAZ",
        "className": "32-bit",
        "fileName": "movaz_z_rza.xml",
        "mask": 4294909440,
        "value": 3229745664,
        "bitCount": 20,
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
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "movaz-single-to-vector"
    }
];
