export const ENCODINGS = [
    {
        "instructionId": "whilelo_pn_rr",
        "encodingId": "whilelo_pn_rr_",
        "mnemonic": "WHILELO",
        "className": "SVE2",
        "fileName": "whilelo_pn_rr.xml",
        "mask": 4280343576,
        "value": 622873616,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "vl",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "lt",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "eq",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "PNd",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-while-compare"
    }
];
