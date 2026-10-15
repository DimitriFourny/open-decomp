export const ENCODINGS = [
    {
        "instructionId": "whilelo_pp_rr",
        "encodingId": "whilelo_pp_rr_",
        "mnemonic": "WHILELO",
        "className": "SVE2",
        "fileName": "whilelo_pp_rr.xml",
        "mask": 4280351761,
        "value": 622877712,
        "bitCount": 17,
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
                "name": "Pd",
                "lsb": 1,
                "width": 3
            },
            {
                "name": "eq",
                "lsb": 0,
                "width": 1
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
