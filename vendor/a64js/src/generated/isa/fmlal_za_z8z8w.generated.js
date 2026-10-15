export const ENCODINGS = [
    {
        "instructionId": "fmlal_za_z8z8w",
        "encodingId": "fmlal_za_z8z8w_4x4",
        "mnemonic": "FMLAL",
        "className": "Four ZA double-vectors",
        "fileName": "fmlal_za_z8z8w.xml",
        "mask": 4293106812,
        "value": 3248556064,
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
                "name": "off2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME_F8F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-long-arithmetic"
    },
    {
        "instructionId": "fmlal_za_z8z8w",
        "encodingId": "fmlal_za_z8z8w_2x2",
        "mnemonic": "FMLAL",
        "className": "Two ZA double-vectors",
        "fileName": "fmlal_za_z8z8w.xml",
        "mask": 4292975676,
        "value": 3248490528,
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
                "name": "off2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME_F8F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-long-arithmetic"
    }
];
