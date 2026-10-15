export const ENCODINGS = [
    {
        "instructionId": "sri_z_zzi",
        "encodingId": "sri_z_zzi_",
        "mnemonic": "SRI",
        "className": "SVE2",
        "fileName": "sri_z_zzi.xml",
        "mask": 4280351744,
        "value": 1157689344,
        "bitCount": 15,
        "fields": [
            {
                "name": "tszh",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "tszl",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "imm3",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2 || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "tszh",
                                "msb": 1,
                                "lsb": 0
                            },
                            {
                                "field": "tszl",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-shift-insert-immediate"
    }
];
