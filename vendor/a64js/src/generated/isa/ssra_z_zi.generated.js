export const ENCODINGS = [
    {
        "instructionId": "ssra_z_zi",
        "encodingId": "ssra_z_zi_",
        "mnemonic": "SSRA",
        "className": "SVE2",
        "fileName": "ssra_z_zi.xml",
        "mask": 4280351744,
        "value": 1157685248,
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
                "name": "R",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
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
        "operandFamilyId": "sve-accumulate-shift-immediate"
    }
];
