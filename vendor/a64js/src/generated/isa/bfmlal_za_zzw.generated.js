export const ENCODINGS = [
    {
        "instructionId": "bfmlal_za_zzw",
        "encodingId": "bfmlal_za_zzw_4x4",
        "mnemonic": "BFMLAL",
        "className": "Four ZA double-vectors",
        "fileName": "bfmlal_za_zzw.xml",
        "mask": 4293106812,
        "value": 3248556048,
        "bitCount": 22,
        "fields": [
            {
                "name": "Zm",
                "lsb": 18,
                "width": 3
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
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
        "operandFamilyId": "sme-float-long-arithmetic"
    },
    {
        "instructionId": "bfmlal_za_zzw",
        "encodingId": "bfmlal_za_zzw_2x2",
        "mnemonic": "BFMLAL",
        "className": "Two ZA double-vectors",
        "fileName": "bfmlal_za_zzw.xml",
        "mask": 4292975676,
        "value": 3248490512,
        "bitCount": 20,
        "fields": [
            {
                "name": "Zm",
                "lsb": 17,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "op",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
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
        "operandFamilyId": "sme-float-long-arithmetic"
    }
];
