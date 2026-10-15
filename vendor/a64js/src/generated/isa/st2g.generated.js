export const ENCODINGS = [
    {
        "instructionId": "ST2G",
        "encodingId": "ST2G_64Soffset_ldsttags",
        "mnemonic": "ST2G",
        "className": "Signed offset",
        "fileName": "st2g.xml",
        "mask": 4292873216,
        "value": 3651143680,
        "bitCount": 13,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "op2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-store"
    },
    {
        "instructionId": "ST2G",
        "encodingId": "ST2G_64Spost_ldsttags",
        "mnemonic": "ST2G",
        "className": "Post-index",
        "fileName": "st2g.xml",
        "mask": 4292873216,
        "value": 3651142656,
        "bitCount": 13,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "op2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-store"
    },
    {
        "instructionId": "ST2G",
        "encodingId": "ST2G_64Spre_ldsttags",
        "mnemonic": "ST2G",
        "className": "Pre-index",
        "fileName": "st2g.xml",
        "mask": 4292873216,
        "value": 3651144704,
        "bitCount": 13,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "op2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-store"
    }
];
