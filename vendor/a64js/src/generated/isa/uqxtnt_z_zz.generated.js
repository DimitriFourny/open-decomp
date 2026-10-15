export const ENCODINGS = [
    {
        "instructionId": "uqxtnt_z_zz",
        "encodingId": "uqxtnt_z_zz_",
        "mnemonic": "UQXTNT",
        "className": "SVE2",
        "fileName": "uqxtnt_z_zz.xml",
        "mask": 4289199104,
        "value": 1159744512,
        "bitCount": 19,
        "fields": [
            {
                "name": "tszh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "tszl",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "U",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "T",
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
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "tszh",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "tszl",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "tszh",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "tszl",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "tszh",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "tszl",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-narrowing-extract"
    }
];
