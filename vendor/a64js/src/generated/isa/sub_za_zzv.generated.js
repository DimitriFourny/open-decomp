export const ENCODINGS = [
    {
        "instructionId": "sub_za_zzv",
        "encodingId": "sub_za_zzv_2x1",
        "mnemonic": "SUB",
        "className": "Two ZA single-vectors",
        "fileName": "sub_za_zzv.xml",
        "mask": 4289764376,
        "value": 3240106008,
        "bitCount": 17,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "S",
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sz",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_I16I64",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "sub_za_zzv",
        "encodingId": "sub_za_zzv_4x1",
        "mnemonic": "SUB",
        "className": "Four ZA single-vectors",
        "fileName": "sub_za_zzv.xml",
        "mask": 4289764376,
        "value": 3241154584,
        "bitCount": 17,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "S",
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sz",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_I16I64",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    }
];
